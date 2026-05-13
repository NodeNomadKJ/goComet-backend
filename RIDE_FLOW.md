# GOComet — Ride Booking System: Complete Architecture & Flow

## The Big Picture (ELI5)

Think of the system as a **relay race** with 4 runners. Each runner does one job and hands
off to the next. Nobody waits for a job to finish — they just drop a message in a mailbox
(Kafka) and move on. This is how the system handles 10k rides/minute without slowing down.

---

## Full Flow Diagram

```
╔══════════════════════════════════════════════════════════════════════════════════════╗
║                     GOCOMET RIDE BOOKING — COMPLETE FLOW                           ║
╠══════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                      ║
║  ┌──────────────────────────────────────────────────────────────────────────────┐   ║
║  │  PHASE 1 — RIDE BOOKING                                                      │   ║
║  └──────────────────────────────────────────────────────────────────────────────┘   ║
║                                                                                      ║
║  Rider clicks "Book Ride"                                                            ║
║       │  HTTP POST /rides  (with X-Idempotency-Key)                                  ║
║       ▼                                                                              ║
║  ┌─────────────┐   saves to DB          ┌──────────────┐                            ║
║  │  API Server │ ──────────────────────► │  PostgreSQL  │  rides.status = REQUESTED  ║
║  │  (NestJS +  │                         └──────────────┘                            ║
║  │   Fastify)  │                                                                     ║
║  └─────────────┘                                                                     ║
║       │  emit Kafka: ride.request.created  ◄── fire-and-forget, returns 201 fast    ║
║       ▼                                                                              ║
║  ┌────────────────────────┐                                                          ║
║  │  Redpanda (Kafka)      │  ← durable message inbox, never loses events            ║
║  │  Topic: ride.request.* │                                                          ║
║  └────────────────────────┘                                                          ║
║                                                                                      ║
║  ┌──────────────────────────────────────────────────────────────────────────────┐   ║
║  │  PHASE 2 — DRIVER MATCHING                                                   │   ║
║  └──────────────────────────────────────────────────────────────────────────────┘   ║
║                                                                                      ║
║  Matching Worker reads message                                                       ║
║       │                                                                              ║
║       ▼                                                                              ║
║  ┌─────────────────────────────────────────────────────┐                            ║
║  │  MatchingService                                    │                            ║
║  │                                                     │                            ║
║  │  1. Acquire Redis lock: matching:lock:{rideId}      │  ← prevents double-match  ║
║  │  2. GEORADIUS drivers:geo:{regionId}                │  ← finds nearby drivers   ║
║  │     lat/lng from ride request, radius 5km           │    stored in Redis GEO     ║
║  │  3. Filter: status=AVAILABLE, vehicleType matches   │                            ║
║  │  4. Rank by distance (closest first)                │                            ║
║  └─────────────────────────────────────────────────────┘                            ║
║       │                                                                              ║
║       │  For each candidate driver (closest first):                                  ║
║       ▼                                                                              ║
║  ┌─────────────────────────────────────────────────────┐                            ║
║  │  Redis SET ride:offer:{rideId}:{driverId}  TTL=6s   │  ← offer expires in 6s    ║
║  │  Redis SUBSCRIBE offer:response:{rideId}:{driverId} │  ← wait for response      ║
║  └─────────────────────────────────────────────────────┘                            ║
║       │                                                                              ║
║       │  WebSocket push to driver                                                    ║
║       ▼                                                                              ║
║  ┌────────────────────────────────────┐                                              ║
║  │  RealtimeService.emitRideOffer()   │                                              ║
║  │  → DriverGateway (namespace /driver)│                                             ║
║  │  → room: driver:{driverEntityId}   │                                              ║
║  │  → event: ride:offer               │                                              ║
║  └────────────────────────────────────┘                                              ║
║                                                │                                     ║
║                                                ▼  Driver's browser shows banner      ║
║                                         ┌──────────────┐                            ║
║                                         │ Driver taps  │                            ║
║                                         │   "Accept"   │                            ║
║                                         └──────────────┘                            ║
║                                                │                                     ║
║                                                │  WebSocket event: offer:response    ║
║                                                ▼                                     ║
║  ┌──────────────────────────────────────────────────────────────────────────────┐   ║
║  │  DriverGateway.handleOfferResponse()                                         │   ║
║  │                                                                               │   ║
║  │  1. driverId = client.data.driverId  ← entity ID resolved on connect        │   ║
║  │  2. Redis EXISTS ride:offer:{rideId}:{driverId}  →  found ✓                 │   ║
║  │  3. Redis DEL ride:offer:{rideId}:{driverId}                                │   ║
║  │  4. Redis PUBLISH offer:response:{rideId}:{driverId}  →  'accepted'         │   ║
║  └──────────────────────────────────────────────────────────────────────────────┘   ║
║                                                │                                     ║
║                                                ▼  Matching Worker receives message   ║
║  ┌──────────────────────────────────────────────────────────────────────────────┐   ║
║  │  MatchingService receives 'accepted'                                          │   ║
║  │  → TripService.createTrip(rideId, driverId, riderId)                         │   ║
║  │  → DB transaction:                                                            │   ║
║  │      INSERT trips  status=DRIVER_ASSIGNED                                     │   ║
║  │      INSERT trip_events  from=null, to=DRIVER_ASSIGNED                        │   ║
║  │  → Kafka emit: trip.status.changed                                            │   ║
║  │  → Kafka emit: notification.push.requested  →  rider push notif              │   ║
║  └──────────────────────────────────────────────────────────────────────────────┘   ║
║                                                                                      ║
║  ┌──────────────────────────────────────────────────────────────────────────────┐   ║
║  │  PHASE 3 — TRIP LIFECYCLE  (driver triggers each step via buttons)           │   ║
║  └──────────────────────────────────────────────────────────────────────────────┘   ║
║                                                                                      ║
║  Every state transition follows this exact pattern:                                  ║
║                                                                                      ║
║  Driver clicks button                                                                ║
║       │  HTTP POST /trips/{id}/{action}                                              ║
║       ▼                                                                              ║
║  ┌──────────────────────────────────────────────────────────────────────────────┐   ║
║  │  TripService                                                                  │   ║
║  │                                                                               │   ║
║  │  1. resolveDriverEntityId(user.sub, tenantId)                                │   ║
║  │     SQL: SELECT id FROM drivers WHERE userId=? AND tenantId=?               │   ║
║  │     (user.sub is JWT userId; trips store driver entity ID — different UUIDs) │   ║
║  │                                                                               │   ║
║  │  2. Authorization: trip.driverId === driverEntityId  ✓                      │   ║
║  │                                                                               │   ║
║  │  3. DB transaction:                                                           │   ║
║  │     UPDATE trips SET status={newStatus}, ...fields                           │   ║
║  │     INSERT trip_events  from={old}, to={new}                                 │   ║
║  │                                                                               │   ║
║  │  4. Kafka emit: trip.status.changed                                           │   ║
║  │  5. Kafka emit: notification.push.requested  →  push to rider                │   ║
║  │                                                                               │   ║
║  │  6. RealtimeService.emitRideStatus(rideId, {status})                        │   ║
║  │     → RiderGateway.server.to('ride:{rideId}').emit('ride:status', payload)  │   ║
║  └──────────────────────────────────────────────────────────────────────────────┘   ║
║                          │                                                           ║
║                          ▼  WebSocket  (rider already joined 'ride:{rideId}' room)  ║
║                   ┌──────────────────┐                                               ║
║                   │  Rider Browser   │  status badge updates live — no page refresh  ║
║                   │  'ride:status'   │                                               ║
║                   │  event received  │                                               ║
║                   └──────────────────┘                                               ║
║                                                                                      ║
║  State machine:                                                                      ║
║  DRIVER_ASSIGNED → DRIVER_ARRIVING → DRIVER_ARRIVED → RIDE_STARTED → COMPLETED     ║
║  (any state can transition to CANCELLED)                                             ║
║                                                                                      ║
║  ┌──────────────────────────────────────────────────────────────────────────────┐   ║
║  │  PHASE 4 — COMPLETION & PAYMENT                                              │   ║
║  └──────────────────────────────────────────────────────────────────────────────┘   ║
║                                                                                      ║
║  Driver clicks "Complete Trip"                                                       ║
║       │  HTTP POST /trips/{id}/complete  (with X-Idempotency-Key)                    ║
║       ▼                                                                              ║
║  ┌──────────────────────────────────────────────────────────────────────────────┐   ║
║  │  TripService.completeRide()                                                   │   ║
║  │                                                                               │   ║
║  │  DB transaction (atomic):                                                     │   ║
║  │    UPDATE trips  status=COMPLETED, finalFare=X, durationSecs=Y, distanceKm=Z │   ║
║  │    INSERT payments  status=PENDING, idempotencyKey=tripId                     │   ║
║  │                                                                               │   ║
║  │  Kafka emits (fire-and-forget, returns 200 immediately):                      │   ║
║  │    payment.charge.requested  →  Payment Worker charges PSP asynchronously    │   ║
║  │    trip.completed            →  consumed by analytics, driver stats          │   ║
║  │    notification.push.requested → rider gets "Trip complete, fare ₹X"        │   ║
║  │                                                                               │   ║
║  │  WebSocket (direct, no Kafka):                                                │   ║
║  │    emitRideStatus(rideId, {status: COMPLETED})                               │   ║
║  │      → room 'ride:{rideId}'  →  rider status badge = COMPLETED              │   ║
║  │    emitToRider(riderId, 'ride:completed', {tripId, finalFare, ...})          │   ║
║  │      → room 'user:{riderId}'  →  rider's personal notification room          │   ║
║  └──────────────────────────────────────────────────────────────────────────────┘   ║
║                                                                                      ║
╠══════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                      ║
║  LOCATION PIPELINE  (parallel, always running while driver is online)               ║
║                                                                                      ║
║  Driver Browser                                                                      ║
║    every 2s → socket.emit('location:update', {lat, lng})                            ║
║       │  WebSocket (same /driver namespace — no extra connection)                    ║
║       ▼                                                                              ║
║  ┌──────────────────────────────────────────────────────────────────────────────┐   ║
║  │  LocationService.updateLocation()                                             │   ║
║  │                                                                               │   ║
║  │  Redis GEOADD drivers:geo:{regionId} {lng} {lat} {driverId}  ← INSTANT      │   ║
║  │    This is what the matching engine reads — always fresh                     │   ║
║  │                                                                               │   ║
║  │  Kafka emit: driver.location.updated  ← for DB persistence                  │   ║
║  └──────────────────────────────────────────────────────────────────────────────┘   ║
║       │                                                                              ║
║       │  (async batch consumer, 30s throttle)                                        ║
║       ▼                                                                              ║
║  ┌──────────────────────────────────────────────────────────────────────────────┐   ║
║  │  LocationSnapshotConsumer (Worker)                                            │   ║
║  │                                                                               │   ║
║  │  Per batch:                                                                   │   ║
║  │    1. Deduplicate — keep latest payload per driverId                         │   ║
║  │    2. Redis NX check — skip driver if written to DB in last 30s              │   ║
║  │    3. Bulk UPDATE drivers SET lastLocationLat/Lng                            │   ║
║  │       FROM unnest($1::uuid[], $2::numeric[], $3::numeric[])                  │   ║
║  │       (one SQL call for entire batch, not N calls)                           │   ║
║  │                                                                               │   ║
║  │  Why: 200k location events/sec → Redis handles it fine (in-memory)          │   ║
║  │       DB only sees ~3-4k writes per 30s window instead of 200k/s            │   ║
║  └──────────────────────────────────────────────────────────────────────────────┘   ║
║                                                                                      ║
╠══════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                      ║
║  WEBSOCKET ROOM ARCHITECTURE                                                        ║
║                                                                                      ║
║  /driver namespace (DriverGateway)                                                   ║
║    driver:{driverEntityId}    ← ride offers, trip updates TO the driver             ║
║                                                                                      ║
║  /rider namespace (RiderGateway)                                                     ║
║    user:{userId}              ← personal notifications (ride:completed, etc.)       ║
║    ride:{rideId}              ← live status updates for a specific ride             ║
║                                 rider joins this room by emitting 'join:ride'       ║
║                                                                                      ║
║  Key insight: driver rooms use driverEntityId (drivers.id),                         ║
║               rider rooms use userId (users.id = JWT user.sub)                      ║
║               These are different UUID spaces — confusion = 403 / silent failures   ║
║                                                                                      ║
╠══════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                      ║
║  REDIS KEY REGISTRY                                                                  ║
║                                                                                      ║
║  drivers:geo:{regionId}           GEOADD   driver GPS coordinates (matching)        ║
║  driver:status:{driverId}         HSET     { status, vehicleType, lastSeen }        ║
║  ride:offer:{rideId}:{driverId}   SET TTL6 offer sent to driver (matching)          ║
║  offer:response:{rideId}:{drvId}  PUBSUB   accept/decline channel (matching)        ║
║  matching:lock:{rideId}           SET NX   prevents duplicate matching              ║
║  driver:snapshot:{driverId}       SET NX   30s throttle for DB location writes      ║
║  idempotency:trips:complete:*     SET TTL  dedup complete-ride replays              ║
║                                                                                      ║
╚══════════════════════════════════════════════════════════════════════════════════════╝
```

---

## Why Each Layer Exists

### PostgreSQL — Source of Truth
Stores everything permanently: users, riders, drivers, rides, trips, payments, events.
Read for historical queries, audit logs, trip history. Never written in the hot path.

### Redis — Speed Layer
- **GEO index**: GEORADIUS in <1ms vs SQL PostGIS query in ~50ms. At 10k rides/min, this matters.
- **Pub/Sub**: Offer response channel delivers accept/decline in microseconds.
- **TTLs**: Offer expiry (6s), status hash expiry (5min), idempotency keys (24h) — all automatic.
- **Locks**: `SET NX` prevents two matching workers from assigning the same driver.

### Kafka (Redpanda) — Async Work Queue
- **Decoupling**: API server doesn't wait for payment, notifications, or DB writes.
- **Durability**: If a consumer crashes, it replays from last offset — no events lost.
- **Scale**: Multiple consumer instances can split the topic partitions.
- **Backpressure**: Producer never blocks; consumers process at their own pace.

### WebSocket — Live Updates
- **Why not polling?** 100k riders polling every 3s = 33k HTTP requests/sec just for status.
- **Socket rooms** let the server push to exactly the right clients in O(1).
- **Same connection**: Driver's location updates and offer responses share the `/driver` socket — no extra connection overhead.

---

## How Ola/Uber Handle This at Real Scale

The pattern here mirrors what large ride-hailing platforms do. The differences at 10M+ scale:

| This Codebase | Ola/Uber at scale |
|---|---|
| Single matching worker | Matching workers sharded by geo region (city/zone) |
| Redpanda (single cluster) | Multi-datacenter Kafka with cross-region replication |
| Redis GEO (single instance) | Redis Cluster (geo keys spread across shards by regionId) |
| 30s location snapshot TTL | Similar — location is always "good enough" from cache |
| Offer TTL 6s | Uber: ~8s; Ola: ~10s depending on driver density |
| Sync trip state machine | Same — ACID transactions for state + async Kafka for side-effects |

The architecture in this codebase is **production-pattern correct**. The differences are
operational (clustering, multi-region, sharding) not architectural.
