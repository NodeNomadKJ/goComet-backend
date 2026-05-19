# GOComet Ride Hailing — Low-Level Design (LLD)

> Companion to `HLD.md`. Covers database schemas, Redis key registry, API contracts,
> algorithm internals, concurrency patterns, and New Relic integration specifics.

---

## 1. Database Schema

All entities extend `BaseEntity` which provides:

```typescript
abstract class BaseEntity {
  id:        string;   // UUIDv7 — time-ordered, generated app-side (not DB)
  tenantId:  string;   // FK → tenants.id — MANDATORY on every table
  regionId:  string;   // FK → regions.id — MANDATORY on every table
  createdAt: Date;
  updatedAt: Date;
  isDeleted: boolean;  // soft delete
}
```

**Why UUIDv7 over v4:**
- Time-ordered → sequential B-tree inserts → no index fragmentation at scale
- Generated at application layer → ID available immediately without a DB round-trip

---

### 1.1 tenants

```sql
CREATE TABLE tenants (
  id           UUID        PRIMARY KEY,
  tenant_id    UUID        NOT NULL,   -- self-reference (BaseEntity compliance)
  region_id    UUID        NOT NULL,
  name         VARCHAR(200) NOT NULL,
  slug         VARCHAR(100) NOT NULL UNIQUE,   -- "gocomet", "ridex"
  config       JSONB        NOT NULL DEFAULT '{}',
  plan         VARCHAR(50)  NOT NULL DEFAULT 'BASIC',
  is_active    BOOLEAN      NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted   BOOLEAN      NOT NULL DEFAULT false
);
```

### 1.2 regions

```sql
CREATE TABLE regions (
  id           UUID         PRIMARY KEY,
  tenant_id    UUID         NOT NULL REFERENCES tenants(id),
  region_id    UUID         NOT NULL,   -- self-reference
  name         VARCHAR(200) NOT NULL,
  country_code CHAR(2)      NOT NULL,
  timezone     VARCHAR(100) NOT NULL,
  config       JSONB        NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted   BOOLEAN      NOT NULL DEFAULT false,

  INDEX idx_regions_tenant (tenant_id)
);
```

### 1.3 users

```sql
CREATE TABLE users (
  id           UUID         PRIMARY KEY,
  tenant_id    UUID         NOT NULL,
  region_id    UUID         NOT NULL,
  name         VARCHAR(200) NOT NULL,
  email        VARCHAR(255) NOT NULL,
  phone        VARCHAR(20),
  password_hash VARCHAR(255) NOT NULL,
  role         VARCHAR(20)  NOT NULL,  -- RIDER | DRIVER | ADMIN
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_deleted   BOOLEAN      NOT NULL DEFAULT false,

  UNIQUE (tenant_id, email),
  INDEX idx_users_tenant_region (tenant_id, region_id, id)
);
```

### 1.4 riders

```sql
CREATE TABLE riders (
  id               UUID         PRIMARY KEY,
  tenant_id        UUID         NOT NULL,
  region_id        UUID         NOT NULL,
  user_id          UUID         NOT NULL REFERENCES users(id),
  name             VARCHAR(200),
  email            VARCHAR(255),
  phone            VARCHAR(20),
  rating           DECIMAL(3,2) NOT NULL DEFAULT 5.0,
  total_rides      INT          NOT NULL DEFAULT 0,
  preferences      JSONB        NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  is_deleted       BOOLEAN      NOT NULL DEFAULT false,

  INDEX idx_riders_tenant_region  (tenant_id, region_id, id),
  INDEX idx_riders_user           (tenant_id, user_id)
);
```

### 1.5 rider_payment_methods

```sql
CREATE TABLE rider_payment_methods (
  id             UUID         PRIMARY KEY,
  tenant_id      UUID         NOT NULL,
  region_id      UUID         NOT NULL,
  rider_id       UUID         NOT NULL REFERENCES riders(id),
  type           VARCHAR(30)  NOT NULL,   -- CARD | UPI | WALLET | CASH
  provider       VARCHAR(50),
  masked_details VARCHAR(100),
  is_default     BOOLEAN      NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  is_deleted     BOOLEAN      NOT NULL DEFAULT false,

  INDEX idx_payment_methods_rider (tenant_id, rider_id)
);
```

### 1.6 drivers

```sql
CREATE TABLE drivers (
  id                   UUID         PRIMARY KEY,
  tenant_id            UUID         NOT NULL,
  region_id            UUID         NOT NULL,
  user_id              UUID         NOT NULL REFERENCES users(id),
  name                 VARCHAR(200),
  email                VARCHAR(255),
  phone                VARCHAR(20),
  status               VARCHAR(20)  NOT NULL DEFAULT 'OFFLINE',
    -- OFFLINE | AVAILABLE | BUSY | ON_TRIP
  rating               DECIMAL(3,2) NOT NULL DEFAULT 5.0,
  total_trips          INT          NOT NULL DEFAULT 0,
  active_vehicle_id    UUID,
  last_location_lat    DECIMAL(10,7),  -- async-only update (Kafka consumer)
  last_location_lng    DECIMAL(10,7),  -- async-only update (Kafka consumer)
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  is_deleted           BOOLEAN      NOT NULL DEFAULT false,

  INDEX idx_drivers_tenant_region  (tenant_id, region_id, id),
  INDEX idx_drivers_user           (tenant_id, user_id),
  INDEX idx_drivers_status         (tenant_id, region_id, status)
    WHERE status = 'AVAILABLE'       -- partial index — matching only reads AVAILABLE
);
```

### 1.7 vehicles

```sql
CREATE TABLE vehicles (
  id             UUID         PRIMARY KEY,
  tenant_id      UUID         NOT NULL,
  region_id      UUID         NOT NULL,
  driver_id      UUID         NOT NULL REFERENCES drivers(id),
  make           VARCHAR(100) NOT NULL,
  model          VARCHAR(100) NOT NULL,
  year           SMALLINT     NOT NULL,
  license_plate  VARCHAR(20)  NOT NULL,
  type           VARCHAR(20)  NOT NULL,  -- ECONOMY | PREMIUM | XL | AUTO | BIKE
  color          VARCHAR(50),
  is_active      BOOLEAN      NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  is_deleted     BOOLEAN      NOT NULL DEFAULT false,

  UNIQUE (tenant_id, license_plate),
  INDEX idx_vehicles_driver (tenant_id, driver_id)
);
```

### 1.8 rides

```sql
CREATE TABLE rides (
  id                UUID         PRIMARY KEY,
  tenant_id         UUID         NOT NULL,
  region_id         UUID         NOT NULL,
  rider_id          UUID         NOT NULL REFERENCES riders(id),
  driver_id         UUID         REFERENCES drivers(id),   -- NULL until matched
  status            VARCHAR(30)  NOT NULL DEFAULT 'REQUESTED',
  vehicle_type      VARCHAR(20)  NOT NULL DEFAULT 'ECONOMY',
  pickup_lat        DECIMAL(10,7) NOT NULL,
  pickup_lng        DECIMAL(10,7) NOT NULL,
  pickup_address    TEXT,
  drop_lat          DECIMAL(10,7) NOT NULL,
  drop_lng          DECIMAL(10,7) NOT NULL,
  drop_address      TEXT,
  fare_estimate     DECIMAL(10,2),
  surge_multiplier  DECIMAL(4,2) NOT NULL DEFAULT 1.0,
  payment_method    VARCHAR(30),
  cancellation_reason TEXT,
  idempotency_key   VARCHAR(255) NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  is_deleted        BOOLEAN      NOT NULL DEFAULT false,

  UNIQUE  (tenant_id, idempotency_key),
  INDEX   idx_rides_tenant_region  (tenant_id, region_id, id),
  INDEX   idx_rides_rider          (tenant_id, region_id, rider_id, created_at DESC),
  INDEX   idx_rides_driver_active  (tenant_id, driver_id, status)
    WHERE status NOT IN ('COMPLETED', 'CANCELLED', 'FAILED')
);
```

### 1.9 trips

```sql
CREATE TABLE trips (
  id               UUID         PRIMARY KEY,
  tenant_id        UUID         NOT NULL,
  region_id        UUID         NOT NULL,
  ride_id          UUID         NOT NULL REFERENCES rides(id),
  driver_id        UUID         NOT NULL REFERENCES drivers(id),
  rider_id         UUID         NOT NULL REFERENCES riders(id),
  status           VARCHAR(30)  NOT NULL,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  duration_secs    INT,
  distance_km      DECIMAL(8,2),
  final_fare       DECIMAL(10,2),
  cancellation_fee DECIMAL(10,2) NOT NULL DEFAULT 0,
  payment_status   VARCHAR(20),
  idempotency_key  VARCHAR(255),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  is_deleted       BOOLEAN      NOT NULL DEFAULT false,

  INDEX idx_trips_ride    (tenant_id, ride_id),
  INDEX idx_trips_driver  (tenant_id, driver_id, status),
  INDEX idx_trips_rider   (tenant_id, rider_id, created_at DESC)
);
```

### 1.10 trip_events (audit log)

```sql
CREATE TABLE trip_events (
  id           UUID        PRIMARY KEY,
  tenant_id    UUID        NOT NULL,
  region_id    UUID        NOT NULL,
  trip_id      UUID        NOT NULL REFERENCES trips(id),
  from_status  VARCHAR(30),
  to_status    VARCHAR(30) NOT NULL,
  actor_id     UUID,          -- userId who triggered the transition
  actor_role   VARCHAR(20),   -- DRIVER | RIDER | SYSTEM
  metadata     JSONB          NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  is_deleted   BOOLEAN        NOT NULL DEFAULT false,

  INDEX idx_trip_events_trip (tenant_id, trip_id, created_at DESC)
);
```

### 1.11 payments

```sql
CREATE TABLE payments (
  id               UUID         PRIMARY KEY,
  tenant_id        UUID         NOT NULL,
  region_id        UUID         NOT NULL,
  trip_id          UUID         NOT NULL REFERENCES trips(id),
  rider_id         UUID         NOT NULL REFERENCES riders(id),
  amount           DECIMAL(10,2) NOT NULL,
  currency         CHAR(3)       NOT NULL DEFAULT 'INR',
  status           VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
    -- PENDING | PROCESSING | COMPLETED | FAILED | REFUNDED
  psp_reference    VARCHAR(255),
  failure_reason   TEXT,
  idempotency_key  VARCHAR(255),
  processed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  is_deleted       BOOLEAN      NOT NULL DEFAULT false,

  UNIQUE  (tenant_id, trip_id),     -- one payment per trip
  INDEX   idx_payments_trip   (tenant_id, trip_id),
  INDEX   idx_payments_rider  (tenant_id, rider_id, created_at DESC)
);
```

---

## 2. Redis Key Registry

All keys are per-region by design, ensuring no cross-region data collision.

```
Key Pattern                              Type    TTL       Purpose
──────────────────────────────────────────────────────────────────────────────────
drivers:geo:{regionId}                  ZSET    none      GEO sorted set — driver positions
                                                          GEOADD / GEORADIUS / GEOPOS

driver:status:{driverId}                HASH    300s      { status, lastLat, lastLng,
                                                            lastSeen, vehicleType }
                                                          Refreshed on every location update

driver:active-ride:{driverId}           STRING  4h        rideId currently assigned to driver

driver:entity:{userId}:{tenantId}       STRING  1h        driverId lookup (avoids DB hit
                                                            on hot location path)

drivers:heartbeat                       ZSET    none      score=epoch, member=driverId
                                                          Used by stale cleanup cron

ride:active:{rideId}                    HASH    4h        { status, driverId, riderId }
                                                          Realtime status cache

ride:offer:{rideId}:{driverId}          STRING  10s       Pending offer sentinel
                                                          Existence = offer outstanding

surge:{regionId}:default                STRING  60s       Surge multiplier float e.g. "1.5"
                                                          Written by cron every 30s

idempotency:rides:{tenantId}:{key}      STRING  24h       Serialized RideEntity JSON
                                                          Replay returns this without DB

idempotency:trips:{tenantId}:{key}      STRING  24h       Serialized response for trip ops

idempotency:payments:{tenantId}:{key}   STRING  24h       Serialized payment response

session:{userId}:{deviceId}             HASH    7d        { refreshTokenHash, issuedAt }
                                                          SHA-256 of refresh token

jwt:blacklist:{jti}                     STRING  TTL=exp   Logout blacklist
                                                          TTL = remaining token lifetime

matching:lock:{rideId}                  STRING  30s       Distributed lock
                                                          SET NX EX 30 (prevents double-assign)

processed:event:{eventId}               STRING  24h       Kafka consumer deduplication
                                                          eventId is UUID from DomainEvent

rate:location:{driverId}                ZSET    sliding   Sliding window rate limiter
                                                          Max 2 updates/sec/driver
```

---

## 3. API Contracts

### Authentication Headers

```
POST  /auth/rider/register
POST  /auth/driver/register
POST  /auth/admin/login
  ← Public (no auth required)

POST  /auth/rider/login
POST  /auth/driver/login
  ← Public; rate limited: 5 requests / IP / 15min
  → Sets HTTP-only Secure cookies: access_token (15min), refresh_token (7d)

POST  /auth/refresh
  ← Requires refresh_token cookie (path-restricted)
  → Rotates refresh token, issues new access token

POST  /auth/logout
  ← Requires access_token cookie
  → Blacklists jti in Redis, clears cookies
```

### 3.1 POST /v1/rides

```
Header: Authorization: Bearer <access_token>  (or cookie)
Header: X-Idempotency-Key: <client-generated UUID>   ← REQUIRED
Header: X-Region-Id: <regionId>

Body:
{
  "pickupLat":     12.9716,
  "pickupLng":     77.5946,
  "pickupAddress": "MG Road, Bangalore",
  "dropLat":       12.9352,
  "dropLng":       77.6245,
  "dropAddress":   "Koramangala, Bangalore",
  "vehicleType":   "ECONOMY",       // ECONOMY | PREMIUM | XL | AUTO | BIKE
  "paymentMethod": "CARD"           // CARD | UPI | WALLET | CASH
}

Response 201:
{
  "id":               "019524a2-...",
  "status":           "REQUESTED",
  "fareEstimate":     156.50,
  "surgeMultiplier":  1.3,
  "vehicleType":      "ECONOMY",
  "pickupAddress":    "MG Road, Bangalore",
  "dropAddress":      "Koramangala, Bangalore",
  "createdAt":        "2026-05-14T10:00:00Z"
}

Response 200 (idempotent replay — same key, same body):
  Same as 201 but fetched from Redis cache — no DB touch.

Validation errors 400:
  - Missing X-Idempotency-Key header
  - pickupLat/Lng out of valid range (-90/90, -180/180)
  - vehicleType not in enum
```

### 3.2 GET /v1/rides/:id

```
Header: Authorization: Bearer <access_token>

Response 200:
{
  "id":              "019524a2-...",
  "status":          "DRIVER_ASSIGNED",
  "driver": {
    "id":            "uuid",
    "name":          "Ramesh K",
    "rating":        4.8,
    "vehicle": {
      "make":        "Maruti",
      "model":       "Swift",
      "licensePlate":"KA-01-AB-1234",
      "color":       "White"
    }
  },
  "fareEstimate":    156.50,
  "surgeMultiplier": 1.3
}

Access control:
  - Rider: can only read their own rides
  - Driver: can only read rides they are assigned to
  - Admin: can read any ride in their tenant
```

### 3.3 POST /v1/drivers/:id/location

```
Header: Authorization: Bearer <access_token>  (DRIVER role)

Body:
{
  "lat":     12.9716,
  "lng":     77.5946,
  "heading": 180,      // optional, degrees 0-360
  "speed":   25.0      // optional, km/h
}

Processing (< 5ms target):
  1. Validate rate limit (2 updates/sec/driver) via Redis sliding window
  2. Redis pipeline (atomic):
       GEOADD  drivers:geo:{regionId}  lng lat driverId
       HSET    driver:status:{driverId}  lastLat lastLng lastSeen heading
       EXPIRE  driver:status:{driverId}  300
       ZADD    drivers:heartbeat  score=epoch  driverId
  3. Kafka emit: driver.location.updated (non-blocking)
  4. Socket.IO emit via RealtimeService to ride:{rideId} room (if driver on active ride)

Response: 204 No Content

Error 429: Rate limit exceeded (> 2 updates/sec)
```

### 3.4 POST /v1/drivers/:id/accept

```
Header: Authorization: Bearer <access_token>  (DRIVER role)
Header: X-Idempotency-Key: <UUID>

Body:
{
  "rideId": "019524a2-..."
}

Processing:
  1. Verify ride:offer:{rideId}:{driverId} exists in Redis (offer valid and not expired)
  2. Publish to Redis pub/sub: offer.response.{rideId}.{driverId}  { accepted: true }
  3. MatchingConsumer receives → acquires matching:lock:{rideId} → creates TripEntity
  4. Idempotency: cached response for 24h

Response 200:
{
  "tripId": "uuid",
  "rideId": "uuid",
  "status": "DRIVER_ASSIGNED"
}
```

### 3.5 POST /v1/trips/:id/end (complete)

```
Header: Authorization: Bearer <access_token>  (DRIVER role)
Header: X-Idempotency-Key: <UUID>

Body:
{
  "distanceKm": 8.4,
  "durationSecs": 1200
}

Processing (within a DB transaction):
  1. Load trip with pessimistic lock (SELECT FOR UPDATE)
  2. Validate: status must be RIDE_STARTED
  3. Calculate final fare:
       finalFare = (baseFare + distanceKm * ratePerKm) * surgeMultiplier
  4. UPDATE trips SET status='COMPLETED', final_fare, distance_km, duration_secs, completed_at
  5. INSERT trip_events (from=RIDE_STARTED, to=COMPLETED)
  6. INSERT payments (status=PENDING, amount=finalFare)
  7. COMMIT
  8. Post-commit (non-blocking):
       Kafka emit: payment.charge.requested
       Kafka emit: trip.status.changed
       Socket.IO emit: ride:status to rider room
       Kafka emit: notification.push.requested

Response 200:
{
  "tripId":    "uuid",
  "status":    "COMPLETED",
  "finalFare": 187.20,
  "paymentId": "uuid"
}
```

### 3.6 POST /v1/payments

```
Header: Authorization: Bearer <access_token>

Body:
{
  "tripId":  "uuid",
  "amount":  187.20,
  "method":  "CARD"
}

Note: Payments are created atomically inside trip completion (POST /trips/:id/complete).
This endpoint is for manual payment triggers or retries only.

Processing:
  Validate payment not already COMPLETED
  Emit payment.charge.requested to Kafka
  Return 202 Accepted (payment is async)

Response 202:
{
  "paymentId": "uuid",
  "status":    "PENDING"
}
```

---

## 4. Matching Engine — Algorithm Detail

Lives in `apps/worker/src/modules/matching/matching.service.ts`.
The worker has no Socket.IO server — it uses `@socket.io/redis-emitter` to write events
into Redis; `apps/api`'s Socket.IO server (via Redis adapter) delivers them to clients.

```typescript
// apps/worker — MatchingService (simplified)
import { Emitter } from '@socket.io/redis-emitter';
const emitter = new Emitter(redis);   // initialised once in constructor

async function startMatching(rideId, tenantId, regionId, riderId, pickupLng, pickupLat,
                              vehicleType, fareEstimate, pickupAddress, dropAddress): Promise<void> {
  // Distributed lock — prevents two worker pods matching the same ride
  const lock = await redis.set(`matching:lock:${rideId}`, '1', 'EX', 30, 'NX');
  if (lock === null) return;   // another pod is already handling this ride

  const declinedKey = `ride:declined:${rideId}`;

  try {
    await dataSource.query(`UPDATE rides SET status = $1 WHERE id = $2`, [RideStatus.MATCHING, rideId]);

    let assigned = false;

    for (const radius of [5, 10, 15]) {
      // Step 1: Geospatial query (Redis only — no PostgreSQL)
      const nearby = await redis.call(
        'GEOSEARCH', `drivers:geo:${regionId}`,
        'FROMLONLAT', pickupLng, pickupLat,
        'BYRADIUS', radius, 'km', 'ASC', 'COUNT', 10, 'WITHDIST',
      );

      // Step 2: Filter — AVAILABLE, right vehicle type, not already declined
      const declined = await redis.smembers(declinedKey);
      const declinedSet = new Set(declined);

      const candidates: DriverCandidate[] = [];
      for (const [driverId, dist] of nearby) {
        if (declinedSet.has(driverId)) continue;
        const status = await redis.hgetall(`driver:status:${driverId}`);
        if (status.status !== DriverStatus.AVAILABLE) continue;
        if (vehicleType !== VehicleType.ANY && status.vehicleType !== vehicleType) continue;
        candidates.push({ driverId, distance: parseFloat(dist), rating: parseFloat(status.rating ?? '5'), vehicleType: status.vehicleType });
      }

      if (candidates.length === 0) continue;   // expand radius

      // Step 3: Rank — rating DESC, then distance ASC; take top 5
      candidates.sort((a, b) => b.rating - a.rating || a.distance - b.distance);
      const top = candidates.slice(0, 5);

      for (const candidate of top) {
        const accepted = await offerRide(rideId, tenantId, regionId, riderId,
                                         candidate.driverId, fareEstimate, pickupAddress, dropAddress);
        if (accepted) { assigned = true; break; }
      }
      if (assigned) break;
    }

    if (!assigned) {
      await dataSource.query(`UPDATE rides SET status = $1 WHERE id = $2`, [RideStatus.FAILED, rideId]);
      await kafkaProducer.emit(KAFKA_TOPICS.RIDE_MATCHING_FAILED, { rideId, tenantId, regionId });
      // Notify rider via redis-emitter (worker has no Socket.IO server)
      emitter.of('/rider').to(`user:${riderId}`).emit('ride:status', { rideId, status: RideStatus.FAILED });
    }
  } finally {
    await redis.del(`matching:lock:${rideId}`);
    await redis.del(declinedKey);
  }
}

async function offerRide(rideId, tenantId, regionId, riderId, driverId,
                          fareEstimate, pickupAddress, dropAddress): Promise<boolean> {
  await redis.set(`ride:offer:${rideId}:${driverId}`,
    JSON.stringify({ offeredAt: Date.now(), riderId }), 'EX', 10, 'NX');

  // Emit offer via redis-emitter — no direct Socket.IO dependency in worker
  emitter.of('/driver').to(`driver:${driverId}`).emit('ride:offer', {
    rideId, riderId, fareEstimate, pickupAddress, dropAddress,
    expiresAt: Date.now() + 10_000,
  });

  // Wait up to 10s for DriverGateway (API) to publish the response
  const response = await waitForOfferResponse(rideId, driverId, 10_000);

  if (!response?.accepted) {
    await redis.sadd(declinedKey, driverId);   // exclude from future rounds
    await redis.del(`ride:offer:${rideId}:${driverId}`);
    return false;
  }

  // Atomic: update ride + create trip in one DB transaction
  const trip = await dataSource.transaction(async (em) => {
    await em.query(`UPDATE rides SET status=$1, "driverId"=$2 WHERE id=$3`,
      [RideStatus.DRIVER_ASSIGNED, driverId, rideId]);
    const entity = em.create(TripEntity, {
      rideId, driverId, riderId, tenantId, regionId,
      status: TripStatus.DRIVER_ASSIGNED, paymentStatus: PaymentStatus.PENDING,
    });
    return em.save(entity);
  });

  // Redis state updates (after DB commit)
  await Promise.all([
    redis.hset(`driver:status:${driverId}`, 'status', DriverStatus.BUSY),
    redis.set(`driver:active-ride:${driverId}`, rideId, 'EX', 14400),
    redis.hset(`ride:active:${rideId}`, 'status', RideStatus.DRIVER_ASSIGNED,
               'driverId', driverId, 'riderId', riderId),
  ]);

  await kafkaProducer.emit(KAFKA_TOPICS.DRIVER_ASSIGNMENT_CREATED,
    { rideId, driverId, riderId, tripId: trip.id });

  // Notify rider and driver via redis-emitter
  emitter.of('/rider').to(`user:${riderId}`)
    .emit('ride:status', { rideId, status: RideStatus.DRIVER_ASSIGNED, driverId });
  emitter.of('/driver').to(`driver:${driverId}`).emit('trip:assigned', trip);

  return true;
}
```

---

## 5. Trip State Machine — Transition Table

```typescript
const ALLOWED_TRANSITIONS: Record<TripStatus, TripStatus[]> = {
  [TripStatus.DRIVER_ASSIGNED]: [TripStatus.DRIVER_ARRIVING, TripStatus.CANCELLED],
  [TripStatus.DRIVER_ARRIVING]: [TripStatus.DRIVER_ARRIVED,  TripStatus.CANCELLED],
  [TripStatus.DRIVER_ARRIVED]:  [TripStatus.RIDE_STARTED,    TripStatus.CANCELLED],
  [TripStatus.RIDE_STARTED]:    [TripStatus.COMPLETED,       TripStatus.CANCELLED],
  [TripStatus.COMPLETED]:       [TripStatus.PAYMENT_PENDING],
  [TripStatus.PAYMENT_PENDING]: [TripStatus.PAYMENT_COMPLETED, TripStatus.FAILED],
  [TripStatus.PAYMENT_COMPLETED]: [],
  [TripStatus.CANCELLED]: [],
  [TripStatus.FAILED]:    [],
};

const CANCELLATION_FEES: Partial<Record<TripStatus, number>> = {
  [TripStatus.DRIVER_ASSIGNED]:  0,
  [TripStatus.DRIVER_ARRIVING]:  0,
  [TripStatus.DRIVER_ARRIVED]:   50,   // driver wasted time
  [TripStatus.RIDE_STARTED]:     50,   // trip already in progress
};

async function transition(tripId: string, toStatus: TripStatus, actorId: string, role: Role): Promise<TripEntity> {
  return dataSource.transaction(async (em) => {
    // Pessimistic lock — prevents concurrent transitions on same trip
    const trip = await em.findOne(TripEntity, { where: { id: tripId }, lock: { mode: 'pessimistic_write' } });

    if (!ALLOWED_TRANSITIONS[trip.status]?.includes(toStatus)) {
      throw new InvalidTripTransitionException(trip.status, toStatus);
    }

    // Access control: driver transitions vs rider transitions
    if (DRIVER_TRANSITIONS.includes(toStatus) && trip.driverId !== actorId) {
      throw new ForbiddenException();
    }
    if (RIDER_TRANSITIONS.includes(toStatus) && trip.riderId !== actorId) {
      throw new ForbiddenException();
    }

    const cancellationFee = toStatus === TripStatus.CANCELLED
      ? (CANCELLATION_FEES[trip.status] ?? 0) : 0;

    await em.update(TripEntity, { id: tripId }, { status: toStatus, cancellationFee });
    await em.save(TripEventEntity, {
      tripId, fromStatus: trip.status, toStatus,
      actorId, actorRole: role, tenantId: trip.tenantId, regionId: trip.regionId,
    });

    return { ...trip, status: toStatus };
  });
  // Post-commit — outside transaction so DB commit is guaranteed first
  await emitKafkaAndSocketIO(tripId, toStatus);
}
```

---

## 6. Location Update Pipeline — Rate Limiter Detail

```typescript
async function checkRateLimit(driverId: string): Promise<boolean> {
  const key = `rate:location:${driverId}`;
  const now = Date.now();
  const windowMs = 1000;  // 1 second window
  const maxUpdates = 2;

  const pipe = redis.pipeline();
  pipe.zremrangebyscore(key, '-inf', now - windowMs);   // remove old entries
  pipe.zadd(key, now, `${now}-${Math.random()}`);       // add current
  pipe.zcount(key, now - windowMs, '+inf');              // count in window
  pipe.expire(key, 2);                                   // clean up key
  const results = await pipe.exec();

  const count = results![2][1] as number;
  return count <= maxUpdates;
}
```

---

## 7. Surge Pricing — Calculation Detail

```typescript
@Cron('*/30 * * * * *')  // every 30 seconds
async calculateAndStoreSurge(): Promise<void> {
  // Find all active regions via Redis GEO keys
  const geoKeys = await redis.keys('drivers:geo:*');

  for (const key of geoKeys) {
    const regionId = key.replace('drivers:geo:', '');
    const nowEpoch = Date.now() / 1000;

    // Count online drivers (heartbeat within last 5 minutes)
    const onlineDrivers = await redis.zcount(
      'drivers:heartbeat', nowEpoch - 300, '+inf',
    );

    // Count active ride requests (from PostgreSQL — cached acceptable here as it's not real-time)
    const activeRides = await rideRepo.count({
      where: { regionId, status: In([RideStatus.MATCHING, RideStatus.DRIVER_ASSIGNED]) },
    });

    const ratio = activeRides / Math.max(onlineDrivers, 1);
    let multiplier: number;

    if (ratio >= 1.8)      multiplier = 2.5;
    else if (ratio >= 1.2) multiplier = 2.0;
    else if (ratio >= 0.8) multiplier = 1.5;
    else                   multiplier = 1.0;

    multiplier = Math.min(multiplier, 3.0);  // hard cap

    await redis.set(`surge:${regionId}:default`, multiplier.toFixed(2), 'EX', 60);

    this.logger.log({ regionId, onlineDrivers, activeRides, ratio, multiplier }, 'Surge updated');
  }
}
```

---

## 8. Idempotency Implementation

Applies to: `POST /rides`, `POST /drivers/:id/accept`, `POST /trips/:id/complete`,
`POST /payments`.

```typescript
// Middleware / guard executed before handler
async function idempotencyGuard(endpoint: string, tenantId: string, key: string) {
  const redisKey = `idempotency:${endpoint}:${tenantId}:${key}`;
  const cached = await redis.get(redisKey);
  if (cached) {
    // Replay: return cached response with original status code
    return { fromCache: true, body: JSON.parse(cached) };
  }
  return { fromCache: false, redisKey };
}

// After successful processing, cache the result
async function cacheIdempotencyResult(redisKey: string, responseBody: object) {
  await redis.set(redisKey, JSON.stringify(responseBody), 'EX', 86400);  // 24h
}
```

**DB-level enforcement** (belt and suspenders):
- `rides.idempotency_key` has a `UNIQUE (tenant_id, idempotency_key)` index.
- Even if Redis is down, a duplicate request will fail at the DB UNIQUE constraint.

---

## 9. Kafka Consumer — Base Class Pattern

All consumers in `apps/worker` extend `KafkaConsumerBase`. A shared `KafkaClientFactory`
creates a single Kafka client reused across all consumers in the worker process.

```typescript
abstract class KafkaConsumerBase {
  abstract topic: string;
  abstract groupId: string;
  abstract handle(event: DomainEvent<unknown>): Promise<void>;

  async onMessage(message: KafkaMessage): Promise<void> {
    const event: DomainEvent = JSON.parse(message.value!.toString());

    // Deduplication — skip already-processed events
    const alreadyProcessed = await processedEvents.isProcessed(event.eventId);
    if (alreadyProcessed) {
      this.logger.log({ eventId: event.eventId }, 'Duplicate event skipped');
      return;
    }

    try {
      await this.handle(event);
    } catch (err) {
      this.logger.error({ eventId: event.eventId, err }, 'Consumer processing failed');
      // After 3 retries (configured in KafkaJS), message goes to DLQ
      throw err;  // let KafkaJS retry
    }
  }
}
```

### Worker Consumers Summary

| Consumer | Topic | Responsibility |
|---|---|---|
| `MatchingConsumer` | `ride.request.created` | Delegates to `MatchingService` — GEOSEARCH, offer flow |
| `PaymentConsumer` | `payment.charge.requested` | Calls mock PSP, emits charge result |
| `NotificationConsumer` | `notification.push.requested` | Sends push/SMS/email |
| `LocationSnapshotConsumer` | `driver.location.updated` | Batch-writes lat/lng to PostgreSQL |
| `TripCompletedConsumer` | `trip.completed` | Resets driver Redis status to AVAILABLE, DELs `driver:active-ride` |
| `DlqConsumer` | DLQ topic | Logs and alerts on failed messages |

---

## 10. New Relic Integration

### Initialization

```typescript
// apps/api/src/main.ts  — must be FIRST import before any other module
if (process.env.NEW_RELIC_ENABLED === 'true') {
  require('newrelic');  // starts agent instrumentation
}
```

### What Gets Auto-Instrumented

New Relic Node.js agent instruments automatically:
- **HTTP requests**: all Fastify/NestJS route handlers → latency, throughput, errors
- **PostgreSQL queries**: via pg driver → query time, slow queries, explain plans
- **Redis operations**: via ioredis → command latency
- **Kafka**: partial (manual spans needed for full tracing)

### Slow Query Detection

```typescript
// packages/database/src/database.module.ts
TypeOrmModule.forRoot({
  ...
  maxQueryExecutionTime: 500,  // log + New Relic custom event for queries > 500ms
  logging: ['query', 'error', 'slow'],
})
```

### Custom Transaction Naming (for cleaner APM grouping)

```typescript
// CorrelationIdMiddleware sets X-Correlation-Id on every request
// New Relic picks this up as the trace ID automatically

// For Kafka consumers, wrap in a New Relic background transaction:
const newrelic = require('newrelic');
newrelic.startBackgroundTransaction('MatchingConsumer/ride.request.created', async () => {
  await this.processMatchingEvent(event);
});
```

### Key Metrics to Monitor in New Relic Dashboard

| Metric | Query (NRQL) |
|---|---|
| API p95 latency | `SELECT percentile(duration, 95) FROM Transaction WHERE appName='gocomet-api'` |
| Slow queries | `SELECT count(*) FROM SlowSqlSample FACET sql` |
| Error rate | `SELECT percentage(count(*), WHERE error IS true) FROM Transaction` |
| Redis latency | `SELECT average(duration) FROM DatastoreSegment WHERE datastoreType='Redis'` |
| Throughput | `SELECT rate(count(*), 1 minute) FROM Transaction FACET name` |

---

## 11. Stale Driver Cleanup

```typescript
@Cron('* * * * *')  // every minute
async cleanupStaleDrivers(): Promise<void> {
  const staleThreshold = Date.now() / 1000 - 300;  // 5 minutes ago

  // Find drivers who haven't sent a heartbeat in > 5 minutes
  const staleDriverIds = await redis.zrangebyscore(
    'drivers:heartbeat', '-inf', staleThreshold,
  );

  for (const driverId of staleDriverIds) {
    await redis.zrem('drivers:heartbeat', driverId);
    const status = await redis.hget(`driver:status:${driverId}`, 'status');

    if (status === DriverStatus.AVAILABLE) {
      // Find the region this driver was in
      const regionId = await resolveDriverRegion(driverId);
      if (regionId) {
        await redis.zrem(`drivers:geo:${regionId}`, driverId);
      }
      await redis.del(`driver:status:${driverId}`);
      // Async DB update — mark driver OFFLINE
      await kafkaProducer.emit(KAFKA_TOPICS.DRIVER_WENT_STALE, { driverId });
    }
  }
}
```

---

## 12. WebSocket Room Management

```typescript
// Rider gateway (namespace: /rider)
@SubscribeMessage('join-ride')
async handleJoinRide(client: Socket, rideId: string): Promise<void> {
  const user = client.data.user;  // set by JWT middleware on connect
  // Verify the rider owns this ride before joining
  const ride = await rideService.findById(rideId, user.tenantId);
  if (ride.riderId !== user.riderId) throw new WsException('Forbidden');
  client.join(`ride:${rideId}`);
}

// Driver gateway (namespace: /driver)
// Driver auto-joins their own room on connect
async handleConnection(client: Socket): Promise<void> {
  const user = client.data.user;
  client.join(`driver:${user.driverId}`);

  // Disconnect handling: mark OFFLINE if no reconnect in 30s
  client.on('disconnect', () => {
    setTimeout(async () => {
      const stillConnected = await redis.hget(`driver:status:${user.driverId}`, 'connected');
      if (!stillConnected) {
        await driverService.setOffline(user.driverId);
      }
    }, 30_000);
  });
}

// RealtimeService — used by other services to emit events
class RealtimeService {
  emitToRideRoom(rideId: string, event: string, data: object) {
    this.server.to(`ride:${rideId}`).emit(event, data);
    // Redis adapter propagates this to all API pods
  }

  emitToDriver(driverId: string, event: string, data: object) {
    this.server.to(`driver:${driverId}`).emit(event, data);
  }
}
```

---

## 13. Environment Configuration

```bash
# apps/api/.env (key variables)

# Database
DATABASE_URL=postgresql://gocomet:secret@localhost:5432/gocomet

# Redis
REDIS_URL=redis://localhost:6379

# Kafka
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=gocomet-api
KAFKA_GROUP_ID=gocomet-api-consumer

# Auth
JWT_ACCESS_SECRET=<64-char-random>
JWT_REFRESH_SECRET=<64-char-random>
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# New Relic
NEW_RELIC_ENABLED=true
NEW_RELIC_LICENSE_KEY=<from New Relic dashboard>
NEW_RELIC_APP_NAME=gocomet-api

# Multi-tenancy
DEFAULT_TENANT_ID=<UUID of seeded tenant>
DEFAULT_REGION_ID=<UUID of seeded region>

# Rate limiting
LOCATION_UPDATE_RATE_LIMIT=2       # per second per driver
LOGIN_RATE_LIMIT=5                  # per 15 minutes per IP

# Surge pricing
SURGE_MAX_MULTIPLIER=3.0
SURGE_RECALC_INTERVAL_SECS=30
```

---

## 14. Project Structure

```
gocomet-ride-hailing/
├── apps/
│   ├── api/                         ← Main NestJS app (REST + Socket.IO — produces Kafka, never consumes)
│   │   └── src/
│   │       ├── main.ts              ← Fastify + New Relic bootstrap
│   │       ├── app.module.ts
│   │       ├── data-source.ts       ← TypeORM CLI data source
│   │       └── modules/
│   │           ├── auth/            ← JWT, guards, strategies
│   │           ├── riders/          ← Rider CRUD, payment methods
│   │           ├── drivers/         ← Driver CRUD, availability, vehicles
│   │           ├── rides/           ← Ride create, fare estimate, cancel
│   │           ├── trips/           ← State machine, transitions
│   │           ├── payments/        ← PaymentEntity, webhook handler
│   │           ├── realtime/        ← Socket.IO gateways, RealtimeService
│   │           ├── surge/           ← SurgePricingCron
│   │           ├── tenants/         ← TenantEntity, RegionEntity
│   │           ├── kafka/           ← KafkaProducerService
│   │           └── users/           ← UserEntity
│   │
│   └── worker/                      ← All Kafka consumers (pure async process)
│       └── src/
│           ├── consumers/
│           │   ├── matching.consumer.ts        ← ride.request.created
│           │   ├── location-snapshot.consumer.ts
│           │   ├── payment.consumer.ts
│           │   ├── notification.consumer.ts
│           │   ├── trip-completed.consumer.ts  ← resets driver to AVAILABLE
│           │   └── dlq.consumer.ts             ← dead-letter queue handler
│           ├── kafka/
│           │   ├── kafka-consumer.base.ts
│           │   ├── kafka-producer.service.ts
│           │   ├── kafka-client.factory.ts
│           │   ├── kafka.module.ts
│           │   └── processed-events.service.ts ← consumer deduplication
│           └── modules/
│               └── matching/
│                   ├── matching.module.ts
│                   ├── matching.service.ts      ← GEOSEARCH + offer flow + redis-emitter
│                   └── interfaces/
│                       └── realtime-event.types.ts
│
├── packages/
│   ├── common/                      ← Shared enums, DTOs, Kafka topic constants
│   ├── database/                    ← TypeORM base entity, DatabaseModule
│   └── redis/                       ← ioredis provider module
│
├── docker/
│   └── docker-compose.yml           ← postgres, redis, redpanda, pgadmin
├── HLD.md                           ← High-level design (this project)
├── LLD.md                           ← Low-level design (this file)
└── PROJECT_PROGRESS.md              ← Implementation tracker
```
