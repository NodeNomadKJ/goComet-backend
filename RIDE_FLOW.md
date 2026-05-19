# GOComet — Complete Ride Flow

> End-to-end walkthrough of every step a ride takes, from fare estimate to payment completion.
> Reflects the current architecture: `apps/api` produces Kafka events only;
> `apps/worker` owns all long-running consumers including matching.

---

## Process Boundary

```
┌────────────────────────────────────────────────────────────────┐
│  apps/api  (HTTP + Socket.IO — never blocks on async work)     │
│                                                                │
│  RideService · TripService · PaymentService                    │
│  DriverGateway · RiderGateway · RealtimeService                │
│  KafkaProducerService  ← produces only, never consumes         │
└─────────────────────────────┬──────────────────────────────────┘
                              │ Kafka topics + Redis pub/sub
┌─────────────────────────────▼──────────────────────────────────┐
│  apps/worker  (pure async consumer process)                    │
│                                                                │
│  MatchingConsumer → MatchingService   (ride.request.created)   │
│  PaymentConsumer                      (payment.charge.*)       │
│  NotificationConsumer                 (notification.push.*)    │
│  LocationSnapshotConsumer             (driver.location.*)      │
│  DlqConsumer                          (dead letter queue)      │
│                                                                │
│  All consumers share ONE Kafka client via KafkaClientFactory   │
└────────────────────────────────────────────────────────────────┘
```

---

## Trip State Machine

```
REQUESTED
    │  Worker MatchingConsumer picks up ride.request.created
    ▼
MATCHING
    │  A driver accepts the offer
    ▼
DRIVER_ASSIGNED ──────────────────────────────────────┐
    │  Driver: PATCH /trips/:id/arriving               │
    ▼                                                  │
DRIVER_ARRIVING                                        │  CANCELLED
    │  Driver: PATCH /trips/:id/arrived                │  (fee = 0 if pre-arrival,
    ▼                                                  │   fee = ₹50 after arrived)
DRIVER_ARRIVED                                         │
    │  Driver: PATCH /trips/:id/start                  │
    ▼                                                  │
RIDE_STARTED ─────────────────────────────────────────┘
    │  Driver: PATCH /trips/:id/complete
    ▼
COMPLETED  (PaymentEntity created atomically)
    │
    ▼  Worker PaymentConsumer
PAYMENT_COMPLETED / PAYMENT_FAILED

FAILED  (no driver found after 5 km / 10 km / 15 km search)
```

---

## Step 1 — Fare Estimate (no DB touch)

```
GET /rides/estimate?pickupLat=&pickupLng=&dropLat=&dropLng=&vehicleType=
       │
       ▼  RideService.estimateFare()
       │
       ├── Haversine formula → distanceKm
       │
       ├── Redis GET surge:{regionId}:default
       │     multiplier = float (1.0 if key absent)
       │     Zero DB touch — always < 1ms
       │
       └── return {
             distanceKm,
             basefare,           ← ECONOMY 30 · PREMIUM 60 · XL 80 · AUTO 20 · BIKE 15 (INR)
             distanceFare,       ← distanceKm × rate/km
             surgeMultiplier,    ← live from Redis (updated every 30s by SurgeCron)
             total,              ← (basefare + distanceFare) × surgeMultiplier
             currency: "INR"
           }
```

---

## Step 2 — Ride Creation

```
POST /rides
  Headers: Authorization: Bearer {jwt}
           X-Idempotency-Key: {uuid}     ← required; prevents duplicate rides on retry
  Body: { pickupLat, pickupLng, pickupAddress, dropLat, dropLng, dropAddress, vehicleType }
```

### RideService.createRide() in apps/api

```
1. Redis GET idempotency:rides:{tenantId}:{key}
      Hit  → return cached RideEntity (HTTP 201, no DB write)
      Miss → continue

2. estimateFare() → live fare breakdown (surge from Redis)

3. PostgreSQL INSERT rides:
     status          = REQUESTED
     riderId         = from JWT
     tenantId        = from JWT
     regionId        = from JWT / X-Region-Id header
     fareEstimate    = computed total
     surgeMultiplier
     pickupLat/Lng/Address, dropLat/Lng/Address, vehicleType
     idempotencyKey  = X-Idempotency-Key header

4. Redis SET idempotency:rides:{tenantId}:{key}  EX 86400
      Cache serialized RideEntity for 24h

5. Kafka emit → ride.request.created
     { rideId, riderId, regionId, vehicleType,
       pickupLat, pickupLng, pickupAddress,
       dropLat, dropLng, dropAddress,
       fareEstimate, surgeMultiplier }

6. HTTP 201 returned immediately — ride is REQUESTED
   Matching has NOT started yet. The Kafka message will trigger it.
```

---

## Step 3 — Matching (Worker Process)

### MatchingConsumer in apps/worker

```
Kafka topic: ride.request.created
  │
  ├── ProcessedEventsService.isProcessed(event.eventId)
  │     Redis GET processed:event:{eventId}
  │     If found → skip (idempotent — same event can arrive multiple times)
  │
  └── MatchingService.startMatching(rideId, tenantId, regionId, riderId, ...)
```

### MatchingService.startMatching()

```
1. Redis SET matching:lock:{rideId} "1" EX 30 NX
      Returns null if key already exists → another worker instance is handling it → return
      Prevents two worker pods running matching for the same ride

2. PostgreSQL UPDATE rides SET status = MATCHING

3. Search loop over radii [5 km, 10 km, 15 km]:
   │
   ├── Redis GEOSEARCH drivers:geo:{regionId}
   │     FROMLONLAT {lng} {lat} BYRADIUS {radius} km ASC COUNT 10 WITHDIST
   │     → [(driverId, distanceKm), ...]   All in-memory, no DB
   │
   ├── Filter each driverId:
   │     Redis HGETALL driver:status:{driverId}
   │       Skip if status ≠ AVAILABLE
   │       Skip if vehicleType mismatch (when requested type ≠ ANY)
   │       Skip if driverId is in Redis SMEMBERS ride:declined:{rideId}
   │
   ├── Sort remaining candidates: rating DESC, then distance ASC
   │
   ├── Take top 5
   │
   └── offerRide() for each → stop on first "accepted"

4. If nothing accepted across all radii:
     PostgreSQL UPDATE rides SET status = FAILED
     Kafka emit → ride.matching.failed
     @socket.io/redis-emitter → /rider room user:{riderId}
       emit("ride:status", { rideId, status: "FAILED" })

5. Finally block (always runs):
     Redis DEL matching:lock:{rideId}
     Redis DEL ride:declined:{rideId}
```

### MatchingService.offerRide() — called per candidate driver

```
1. Redis SET ride:offer:{rideId}:{driverId}
      value = JSON { offeredAt, riderId }
      EX 10   ← offer expires in 10 seconds

2. @socket.io/redis-emitter → /driver room driver:{driverId}
      emit("ride:offer", {
        rideId, riderId,
        pickupLat, pickupLng, pickupAddress, dropAddress,
        fareEstimate, vehicleType,
        expiresAt: now + 10_000
      })
      Worker has no Socket.IO server — emitter writes an event to Redis.
      apps/api Socket.IO server (which has the Redis adapter) picks it up and
      delivers it to whichever API pod the driver is connected to.

3. Redis SUBSCRIBE offer:response:{rideId}:{driverId}
      Wait up to 10 seconds for a message from DriverGateway

──── DECLINED or TIMEOUT ─────────────────────────────────────────
4. Redis SADD ride:declined:{rideId} {driverId}  (EX 1800)
   Redis DEL  ride:offer:{rideId}:{driverId}
   Move on to next candidate

──── ACCEPTED ────────────────────────────────────────────────────
4. DB transaction (atomic — ride update + trip insert in one round-trip):
     UPDATE rides SET status = DRIVER_ASSIGNED, driverId = {driverId}
     em.create(TripEntity, {
       rideId, driverId, riderId, tenantId, regionId,
       status = DRIVER_ASSIGNED, paymentStatus = PENDING,
       startedAt/completedAt/finalFare = null
     })
     em.save(TripEntity, entity)
   → returns TripEntity with generated ID

5. Redis (tight sequence — driver marked BUSY before any other matching sees them):
     HSET driver:status:{driverId}  status BUSY
     SET  driver:active-ride:{driverId}  {rideId}  EX 14400  (4 h)
     HSET ride:active:{rideId}  status DRIVER_ASSIGNED
                                driverId {driverId}
                                riderId  {riderId}

6. Kafka emit → driver.assignment.created
      { rideId, driverId, riderId, tripId }

7. @socket.io/redis-emitter → /rider room user:{riderId}
      emit("ride:status", { rideId, status: "DRIVER_ASSIGNED", driverId })

8. @socket.io/redis-emitter → /driver room driver:{driverId}
      emit("trip:assigned", tripEntity)

9. Redis DEL ride:offer:{rideId}:{driverId}
```

---

## Step 4 — Driver Accepts Offer (DriverGateway — pure relay)

**Lives in apps/api. Does nothing except forward the answer to the worker.**

```
Driver phone  →  Socket.IO /driver namespace
                 event: "offer:response"
                 data: { rideId, accepted: true }

DriverGateway.handleOfferResponse():
  1. driverId = client.data.driverId
     (resolved to driver entity ID at socket connect time — different from JWT userId)

  2. Redis EXISTS ride:offer:{rideId}:{driverId}
       Not found → offer expired → emit error to driver, return

  3. Redis DEL ride:offer:{rideId}:{driverId}
       Removes the offer key before publishing so a second tap gets "not found"
       This makes accept idempotent — no double-assignment race

  4. Redis PUBLISH offer:response:{rideId}:{driverId}  "accepted" | "declined"
       Worker's subscriber (Step 3 above) receives this message and runs the transaction

  Gateway does NOTHING ELSE.
  No DB writes. No ride status update. No trip creation. No Redis state changes.
  All assignment logic is owned by the worker in one atomic transaction.
```

**Why the gateway is a dumb relay and not the owner:**
- If the gateway wrote to DB, two slow worker iterations could both receive the pub/sub
  message and each try to INSERT a trip row — a double-trip race.
- The worker's accepted block is the single owner: one transaction writes ride + trip
  atomically. Only after that succeeds does Redis state get updated.

---

## Step 5 — Driver En Route (DRIVER_ARRIVING)

```
Driver  →  PATCH /trips/{tripId}/arriving
               │
               ▼  TripService.markArriving()

1. Load TripEntity, verify trip.driverId matches caller's driverEntityId
2. Validate current status = DRIVER_ASSIGNED  → 400 if not

3. DB transaction:
     UPDATE rides  SET status = DRIVER_ARRIVING
     UPDATE trips  SET status = DRIVER_ARRIVING
     INSERT trip_events { fromStatus: DRIVER_ASSIGNED, toStatus: DRIVER_ARRIVING,
                          actorId: driverId, actorRole: DRIVER }

4. Kafka emit → trip.status.changed
      { tripId, fromStatus: DRIVER_ASSIGNED, toStatus: DRIVER_ARRIVING }

5. Kafka emit → notification.push.requested
      { userId: riderId, type: "DRIVER_ARRIVING",
        title: "Driver On the Way", body: "..." }

6. RealtimeService → Socket.IO /rider room ride:{rideId}
      emit("ride:status", { rideId, status: "DRIVER_ARRIVING" })

HTTP 200 → updated TripEntity
```

---

## Step 6 — Driver at Pickup (DRIVER_ARRIVED)

```
Driver  →  PATCH /trips/{tripId}/arrived
               │
               ▼  TripService.markArrived()

Same pattern as Step 5:
  Validates: current status = DRIVER_ARRIVING
  Transaction: rides + trips + trip_events
  Kafka: trip.status.changed · notification.push.requested (type: DRIVER_ARRIVED)
  Socket.IO → rider: ride:status DRIVER_ARRIVED
```

---

## Step 7 — Ride Starts (RIDE_STARTED)

```
Driver  →  PATCH /trips/{tripId}/start
               │
               ▼  TripService.startRide()

  Validates: current status = DRIVER_ARRIVED
  Transaction: rides + trips (sets startedAt = now) + trip_events
  Kafka: trip.status.changed · notification.push.requested (type: RIDE_STARTED)
  Socket.IO → rider: ride:status RIDE_STARTED
```

---

## Step 8 — Ride Completes (COMPLETED + Payment Created)

```
Driver  →  PATCH /trips/{tripId}/complete
          Body: { distanceKm: 8.4 }
               │
               ▼  TripService.completeRide()

1. Load trip, verify driver, validate status = RIDE_STARTED
2. Load RideEntity to get fareEstimate (used as finalFare)

3. DB transaction (single round-trip, atomic):
     UPDATE rides  SET status = COMPLETED
     UPDATE trips  SET status = COMPLETED,
                        completedAt = now, startedAt (already set),
                        durationSecs, distanceKm, finalFare,
                        paymentStatus = PENDING
     INSERT trip_events { toStatus: COMPLETED }
     INSERT payments {
       tripId, riderId, tenantId, regionId,
       amount = finalFare, currency = "INR",
       status = PENDING,
       idempotencyKey = tripId     ← UNIQUE constraint — no duplicate payment row
     }

4. Kafka emit → trip.completed
      { tripId, rideId, riderId, driverId, finalFare, distanceKm, durationSecs }

5. Kafka emit → payment.charge.requested
      { tripId, riderId, amount: finalFare, currency: "INR", tenantId, regionId }

6. Kafka emit → notification.push.requested
      { userId: riderId, type: "RIDE_COMPLETED",
        body: "Total fare: ₹{finalFare}" }

7. RealtimeService → Socket.IO:
     /rider room ride:{rideId}  → emit("ride:status", { status: COMPLETED })
     /rider room user:{riderId} → emit("ride:completed", { tripId, finalFare, distanceKm, durationSecs })

HTTP 200 returned immediately.
PSP charge happens asynchronously in the worker — HTTP response does NOT wait for it.
```

---

## Step 9 — Payment Processing (Worker)

### PaymentConsumer in apps/worker

```
Kafka topic: payment.charge.requested
  │
  ├── ProcessedEventsService.isProcessed() → skip if already handled
  │
  └── Mock PSP call (200ms delay, 90% success rate)

      SUCCESS → Kafka emit → payment.charge.completed
                  { paymentId, pspReference, status: "success" }

      FAILURE → Kafka emit → payment.charge.failed
                  { paymentId, failureReason, status: "failure" }
```

### apps/api — PaymentService / webhook handler

```
POST /payments/webhook  (PSP calls back, or payment.charge.completed consumed)
  1. Verify HMAC-SHA256 signature
  2. UPDATE payments SET status = COMPLETED / FAILED
  3. Kafka emit → notification.push.requested → rider notified of result
```

---

## Step 10 — Notifications (Worker)

```
Kafka topic: notification.push.requested
  │
  ▼  NotificationConsumer
  │
  └── ProcessedEventsService dedup
      → simulate push (FCM/SMS — currently logged, not live-sent)
```

Notifications are fully decoupled. A failed notification never affects ride state
and never blocks the HTTP response that originally triggered the event.

---

## Cancellation Flow

### Before driver assigned (status: REQUESTED or MATCHING)

```
Rider  →  DELETE /rides/{rideId}
               │
               ▼  RideService.cancelRide()

  1. Verify riderId owns the ride
  2. Validate status ∈ { REQUESTED, MATCHING }
  3. UPDATE rides SET status = CANCELLED, cancellationReason
  4. Kafka emit → ride.request.cancelled
  HTTP 200

  No trip exists yet → no fee, no driver notification.
```

### After driver assigned (status: DRIVER_ASSIGNED … RIDE_STARTED)

```
Rider  →  DELETE /rides/{rideId}
  RideService detects post-assignment status
  Delegates to TripService.cancelTripByRideId()

Driver →  DELETE /trips/{tripId}
  Calls TripService.cancelTrip(actorRole: "DRIVER") directly

Both paths reach TripService.cancelTrip():

  1. Validate actorId owns the trip
  2. Validate status ∈ cancellable set

  3. Fee calculation:
       DRIVER_ASSIGNED or DRIVER_ARRIVING  → cancellationFee = 0
       DRIVER_ARRIVED or RIDE_STARTED      → cancellationFee = ₹50

  4. DB transaction:
       UPDATE rides SET status = CANCELLED, cancellationReason
       UPDATE trips SET status = CANCELLED, cancellationFee
       INSERT trip_events { toStatus: CANCELLED, actorRole, cancellationFee }

  5. Kafka emit → trip.status.changed
       { fromStatus, toStatus: CANCELLED, actorRole, reason, cancellationFee }

  6. Kafka emit → notification.push.requested
       → notify the OTHER party (rider if driver cancelled; driver if rider cancelled)

  7. RealtimeService → Socket.IO /rider room ride:{rideId}
       emit("ride:status", { rideId, status: "CANCELLED" })

  HTTP 200
```

---

## Location Pipeline (parallel, always running)

```
Driver phone sends GPS every 2 seconds via Socket.IO
  event: "location:update"  { lat, lng, heading, accuracy }
       │
       ▼  LocationService.updateLocation()

  Redis pipeline (MULTI/EXEC — single round-trip, atomic):
    GEOADD   drivers:geo:{regionId}  {lng} {lat} {driverId}
    HSET     driver:status:{driverId}  lastLat lastLng lastSeen
    EXPIRE   driver:status:{driverId}  300
    ZADD     drivers:heartbeat  score=epoch  driverId

  Kafka emit → driver.location.updated   ← async, does NOT block response

  HTTP 204 returned < 5ms
       │
       ▼  apps/worker — LocationSnapshotConsumer (consumes in batches)

  Per batch:
    1. Deduplicate — keep only the latest payload per driverId in batch
    2. Redis NX throttle — skip driver if written to DB within last 30s
    3. Bulk UPDATE drivers SET lastLocationLat/Lng
       FROM unnest($1::uuid[], $2::float[], $3::float[])
       One SQL call for the entire batch

  Why: 200k location events/sec → Redis handles all reads for matching (< 1ms).
       PostgreSQL only sees ~3-4k writes per 30-second window instead of 200k/s.
```

---

## Real-Time WebSocket Events — Complete Reference

| Trigger | Namespace | Room | Event name | Payload |
|---|---|---|---|---|
| No match found | `/rider` | `user:{riderId}` | `ride:status` | `{ rideId, status: "FAILED" }` |
| Driver assigned | `/rider` | `user:{riderId}` | `ride:status` | `{ rideId, status: "DRIVER_ASSIGNED", driverId }` |
| Driver assigned | `/driver` | `driver:{driverId}` | `trip:assigned` | TripEntity |
| New offer sent | `/driver` | `driver:{driverId}` | `ride:offer` | `{ rideId, fareEstimate, pickupAddress, expiresAt, ... }` |
| Driver arriving | `/rider` | `ride:{rideId}` | `ride:status` | `{ rideId, status: "DRIVER_ARRIVING" }` |
| Driver arrived | `/rider` | `ride:{rideId}` | `ride:status` | `{ rideId, status: "DRIVER_ARRIVED" }` |
| Ride started | `/rider` | `ride:{rideId}` | `ride:status` | `{ rideId, status: "RIDE_STARTED" }` |
| Ride completed | `/rider` | `ride:{rideId}` | `ride:status` | `{ rideId, status: "COMPLETED" }` |
| Ride completed | `/rider` | `user:{riderId}` | `ride:completed` | `{ tripId, finalFare, distanceKm, durationSecs }` |
| Ride cancelled | `/rider` | `ride:{rideId}` | `ride:status` | `{ rideId, status: "CANCELLED" }` |

**Events from matching phase** (FAILED, DRIVER_ASSIGNED, ride:offer) are emitted by the worker
via `@socket.io/redis-emitter`. The worker has no Socket.IO server — it writes an event to
Redis; apps/api Socket.IO server picks it up via the Redis adapter and delivers it.

**Events from trip phase** (DRIVER_ARRIVING onward) are emitted directly by `RealtimeService`
in apps/api, since those transitions come in as HTTP calls to apps/api.

---

## Kafka Topic Map

```
Producer (process)            Topic                          Consumer (process)
────────────────────────────────────────────────────────────────────────────────────
RideService (api)        →  ride.request.created        →  MatchingConsumer  (worker)
RideService (api)        →  ride.request.cancelled      →  NotificationConsumer (worker)
MatchingService (worker) →  ride.matching.failed        →  NotificationConsumer (worker)
MatchingService (worker) →  driver.assignment.created   →  NotificationConsumer (worker)
TripService (api)        →  trip.status.changed         →  NotificationConsumer (worker)
TripService (api)        →  trip.completed              →  (analytics — future)
TripService (api)        →  payment.charge.requested    →  PaymentConsumer  (worker)
PaymentConsumer (worker) →  payment.charge.completed    →  PaymentService webhook (api)
PaymentConsumer (worker) →  payment.charge.failed       →  PaymentService webhook (api)
LocationService (api)    →  driver.location.updated     →  LocationSnapshotConsumer (worker)
Multiple                 →  notification.push.requested →  NotificationConsumer (worker)
```

---

## Redis Key Lifecycle

```
Key pattern                               Created            Expires / Deleted
──────────────────────────────────────────────────────────────────────────────────────
idempotency:rides:{tenantId}:{key}        ride creation      TTL 24h
matching:lock:{rideId}                    matching start     matching finally block
ride:declined:{rideId}                    first decline      matching finally block
ride:offer:{rideId}:{driverId}            per offer          gateway DEL or TTL 10s
driver:status:{driverId}  status=BUSY     on accept          driver goes AVAILABLE
driver:active-ride:{driverId}             on accept          TTL 4h (14400s)
ride:active:{rideId}                      on accept          not explicitly deleted
processed:event:{eventId}                 any consumer       TTL 24h
surge:{regionId}:default                  SurgeCron          TTL 60s (overwritten every 30s)
```

---

## Idempotency Guarantees

| Scenario | Mechanism |
|---|---|
| Rider retries POST /rides | X-Idempotency-Key → Redis cache → same RideEntity returned |
| Worker receives duplicate Kafka event | `ProcessedEventsService.isProcessed(eventId)` → skip |
| Two workers race on same ride.request.created | `matching:lock:{rideId} NX` → only one proceeds |
| Driver taps Accept twice | offer key deleted before pub/sub publish → second tap returns error |
| PaymentEntity created twice | UNIQUE constraint on `payments(tenantId, tripId)` → second INSERT fails |
| POST /trips/:id/complete replayed | idempotency key = tripId stored in PaymentEntity |

---

## Data Written at Each Stage

```
Stage                    PostgreSQL                         Redis
─────────────────────────────────────────────────────────────────────────────────
Fare estimate            —                                  GET surge (read only)
Ride creation            rides INSERT                       idempotency:rides SET
Matching start           rides UPDATE (MATCHING)            matching:lock SET NX
Assignment               rides UPDATE (DRIVER_ASSIGNED)     driver:status HSET
                         trips INSERT                       driver:active-ride SET
                                                            ride:active HSET
Driver arriving          rides UPDATE · trips UPDATE        —
                         trip_events INSERT
Driver arrived           rides UPDATE · trips UPDATE        —
                         trip_events INSERT
Ride started             rides UPDATE · trips UPDATE        —
                         trip_events INSERT
Ride completed           rides UPDATE · trips UPDATE        —
                         trip_events INSERT
                         payments INSERT
Payment result           payments UPDATE                    —
Cancellation             rides UPDATE · trips UPDATE        —
                         trip_events INSERT
```
