# GOComet Ride Hailing — High-Level Design (HLD)

> **Assignment:** Multi-tenant, multi-region ride-hailing platform at Uber/Ola scale  
> **Scale targets:** 100k drivers · 10k ride req/min · 200k location updates/sec  
> **Stack:** NestJS 11 + Fastify · PostgreSQL 18 · Redis 8 · Kafka (Redpanda) · Socket.IO

---

## 1. System Overview

GOComet is a **multi-tenant, multi-region** ride-hailing platform. Multiple transport companies
(tenants) operate under the same platform, each with one or more geographic regions. Every piece of
data — rides, drivers, trips, payments — is scoped by `(tenant_id, region_id)` so tenants are
completely isolated at the data layer.

### Core Capabilities

| Capability | Target |
|---|---|
| Real-time driver location ingestion | 200,000 updates/sec across all regions |
| Ride request creation + fare estimate | < 200ms p95 |
| Driver–rider matching | < 1s p95 (offer accepted) |
| Trip lifecycle management | 11 explicit states, no skipping |
| Dynamic surge pricing | Recalculated every 30 seconds per region |
| Async payment via PSP | Never blocks the trip-complete request path |
| Push / SMS / email notifications | Event-driven, never inline |
| Live frontend updates | Socket.IO streams ride status + driver position |

---

## 2. High-Level Architecture

```
                         ┌─────────────────────────────────────────────────────────┐
                         │                   CLIENT LAYER                          │
                         │   Browser / Mobile App  ←→  Socket.IO WebSocket        │
                         └─────────────────────────┬───────────────────────────────┘
                                                   │ HTTPS + WS
                         ┌─────────────────────────▼───────────────────────────────┐
                         │                    API GATEWAY / LB                     │
                         │        (Nginx / AWS ALB — round-robin, sticky WS)       │
                         └──────┬──────────────────────────────────────┬───────────┘
                                │                                      │
               ┌────────────────▼───────────┐         ┌───────────────▼────────────┐
               │     apps/api  (NestJS)     │         │   apps/api  (NestJS)       │
               │     REST + Socket.IO       │   ...   │   REST + Socket.IO         │
               │     node 1  (region-A)     │         │   node N  (region-B)       │
               └──────┬──────────┬──────────┘         └────────┬───────────────────┘
                      │          │                              │
          ┌───────────▼──┐  ┌───▼──────────────┐   ┌──────────▼──────────┐
          │  PostgreSQL  │  │    Redis 8        │   │   Kafka (Redpanda)  │
          │  (per region)│  │  (per region)     │   │   (shared cluster)  │
          │  Rides/Trips │  │  GEO · Pub/Sub    │   │   12 topics         │
          │  Drivers     │  │  Sessions · Surge │   │   (see §7)          │
          └──────────────┘  └───────────────────┘   └──────────┬──────────┘
                                                                │
                                              ┌─────────────────▼──────────────┐
                                              │      apps/worker  (NestJS)     │
                                              │  PaymentConsumer               │
                                              │  NotificationConsumer          │
                                              │  LocationSnapshotConsumer      │
                                              └────────────────────────────────┘
```

### Key Separation of Concerns

| Component | Responsibility |
|---|---|
| `apps/api` | All HTTP endpoints + Socket.IO gateway + Matching consumer (needs WS access) |
| `apps/worker` | Heavy async consumers — payment processing, notifications, DB snapshots |
| `packages/database` | TypeORM entities, migrations, shared DB module |
| `packages/redis` | ioredis provider, injected across both apps |
| `packages/common` | DTOs, enums, Kafka topic constants, event interfaces |

---

## 3. Multi-Tenant Architecture

Every tenant is a separate company (e.g., GoComet Mumbai, RideX Delhi) using the platform.

### Isolation Mechanism

```
Tenant A ──► tenant_id = "t1"  ─┐
Tenant B ──► tenant_id = "t2"   ├──► Same PostgreSQL cluster, separate rows
Tenant C ──► tenant_id = "t3"  ─┘    Row-level scoping on EVERY query
```

**How isolation is enforced:**

1. **JWT payload** carries `tenantId` — set at registration, immutable.
2. **Every entity** extends `BaseEntity` which has `tenantId` + `regionId` columns.
3. **Every service query** includes `WHERE tenant_id = $1` — no query omits it.
4. **Redis keys** are namespaced: `drivers:geo:{regionId}`, `surge:{regionId}:default`.
5. **Kafka events** carry `tenantId` in the `DomainEvent` envelope — consumers filter by it.

### Tenant Data Model

```
TenantEntity
  id          UUID (PK)
  name        "GoComet"
  slug        "gocomet"   (unique — used for subdomain routing)
  config      JSONB       (tenant-specific feature flags, pricing overrides)
  plan        BASIC | PRO | ENTERPRISE
  isActive    boolean

RegionEntity
  id          UUID (PK)
  tenantId    UUID (FK → tenants)
  name        "Mumbai Metro"
  countryCode "IN"
  timezone    "Asia/Kolkata"
  config      JSONB       (regional surge caps, vehicle types allowed)
```

---

## 4. Multi-Region Architecture

### What "Region" Means Here

In this platform, **region = a geographic service area** — a city or metro zone like Mumbai,
Delhi, or Bangalore. This is the same meaning Uber and Ola use: each city is a separate
operational unit with its own driver pool, surge pricing, and ride data.

This is different from an **AWS region** (`ap-south-1`, `us-east-1`), which is a cloud
infrastructure concept. A single AWS region can host multiple geographic service regions.

```
Geo-Region concept (what this system means by "region"):

  Tenant: GoComet
  ├── Region: Mumbai Metro     (regionId = uuid-mumbai)
  │     drivers pool, rides, surge multiplier — all scoped to Mumbai
  ├── Region: Delhi NCR        (regionId = uuid-delhi)
  │     completely separate driver pool and surge from Mumbai
  └── Region: Bangalore        (regionId = uuid-blr)
        a driver in Bangalore never appears in a Mumbai rider's match results
```

**Why geo-regions need data isolation:**
- A Mumbai rider must only see Mumbai drivers — not drivers 1400km away in Delhi.
- Surge pricing in Mumbai (high demand) must not affect Delhi's multiplier.
- A Mumbai ride cancellation must not lock or touch Delhi's trip records.
- Each city can scale independently — Delhi going viral doesn't slow down Bangalore.

---

### How Multi-Geo-Region Is Implemented

Every piece of data is tagged with `region_id` from creation. The application enforces that
no operation reads or writes across region boundaries.

```
Single PostgreSQL DB: gocomet_rides
  ┌─────────────────────────────────────────────────────────┐
  │  rides table                                            │
  │  ┌──────────┬──────────┬──────────────────────────┐    │
  │  │ id       │ region_id│ ...                       │    │
  │  ├──────────┼──────────┼──────────────────────────┤    │
  │  │ uuid-1   │ mumbai   │ pickup: Bandra, fare: 150 │    │ ← Mumbai ride
  │  │ uuid-2   │ delhi    │ pickup: CP, fare: 120     │    │ ← Delhi ride
  │  │ uuid-3   │ mumbai   │ pickup: Andheri, fare: 90 │    │ ← Mumbai ride
  │  └──────────┴──────────┴──────────────────────────┘    │
  │  All queries: WHERE tenant_id=$1 AND region_id=$2       │
  └─────────────────────────────────────────────────────────┘

Single Redis instance (keys namespaced by regionId):
  drivers:geo:uuid-mumbai  →  GEO set of Mumbai drivers only
  drivers:geo:uuid-delhi   →  GEO set of Delhi drivers only
  surge:uuid-mumbai:default → 1.8  (Mumbai is busy right now)
  surge:uuid-delhi:default  → 1.0  (Delhi is quiet)

Matching engine (per-region isolation):
  Mumbai ride request → GEORADIUS drivers:geo:uuid-mumbai → Mumbai drivers only
  Delhi ride request  → GEORADIUS drivers:geo:uuid-delhi  → Delhi drivers only
  Cross-region match is architecturally impossible
```

**What this achieves for the assignment:**
- A rider in Mumbai only ever gets matched to drivers in Mumbai's GEO index.
- Surge pricing is calculated and stored independently per region every 30 seconds.
- Cancelling a Mumbai ride only touches rows where `region_id = uuid-mumbai`.
- Adding a new city (Hyderabad) requires zero code changes — just insert a new `RegionEntity`.

### If This Were Deployed on AWS

The same geo-region concept maps cleanly onto cloud infrastructure when traffic justifies it:

```
AWS ap-south-1 (single cloud region hosting all cities — current design):
  gocomet-api pods
  RDS PostgreSQL: one DB, all cities separated by region_id column
  ElastiCache Redis: one instance, keys namespaced by regionId

Evolution when a city needs physical isolation (e.g., Mumbai at 10M rides/day):
  Option A: PostgreSQL PARTITION BY LIST (region_id) → zero app changes
  Option B: Separate RDS instance for Mumbai, connection router in app → zero schema changes
  Option C: Deploy Mumbai stack to a dedicated AWS region for data residency laws

All options require zero schema changes and zero application logic changes
because region_id is already the partition key on every table and every query.
```

### Cross-Region Sync (Async Only)

```
Mumbai API  ──► Kafka topic: region.data.sync  ──► Delhi worker (eventual consistency)
                                                 ──► Analytics aggregator
                                                 ──► Global reporting DB
```

**Write rules:**
- A ride requested in Mumbai is created in Mumbai's PostgreSQL — never Delhi's.
- Driver location updates in Mumbai write to Mumbai's Redis GEO index only.
- Cross-region sync for analytics / dashboards happens via Kafka consumers asynchronously.

### Regional Routing

At the API gateway layer, requests are routed to the closest region by:
1. `X-Region-Id` header (set by mobile client based on GPS)
2. Subdomain: `mumbai.gocomet.io` → Mumbai cluster
3. Fallback: geo-IP detection

---

## 5. Component Deep-Dives

### 5.1 Location Ingestion Pipeline (200k updates/sec)

```
Driver HTTP POST /drivers/location
        │
        ▼
  Rate limiter  ──► 2 updates/sec/driver (Redis sliding window)
        │
        ▼
  Redis pipeline (MULTI/EXEC — atomic, single round-trip):
    GEOADD  drivers:geo:{regionId}  lng lat driverId
    HSET    driver:status:{driverId}  lastLat lastSeen lastLng
    EXPIRE  driver:status:{driverId}  300
    ZADD    drivers:heartbeat  score=epoch  driverId
        │
        ▼
  Kafka emit: driver.location.updated
        │  (async, does NOT block HTTP response)
        ▼
  HTTP 204  ← returned in < 5ms
        
  Worker (LocationSnapshotConsumer):
    Consumes driver.location.updated in batches
    Deduplicates: keeps only the latest payload per driverId in each batch
    Redis NX throttle: skips DB write if same driver was written within last 30s
    Batch-updates PostgreSQL last_location_lat/lng (at most once per driver per 30s)
    (PostgreSQL never touched in the hot path)
```

**Why this works at 200k/sec:**
- Redis GEO pipeline = single network round-trip per update
- No PostgreSQL writes in the request path (Rule 1)
- Horizontal scaling: 100 API pods × 2,000 updates/sec each = 200k/sec
- Kafka consumer handles DB writes in micro-batches out-of-band

### 5.2 Driver–Rider Matching Engine

```
Rider creates ride  ──► RideService.createRide()
                    ──► Kafka emit: ride.request.created

MatchingConsumer (in API app, co-located with Socket.IO):
  1. GEORADIUS drivers:geo:{regionId} {lat} {lng} 5km
  2. Filter: only driverIds where driver:status:{id}.status = AVAILABLE
  3. Rank: sort by (rating DESC, distance ASC)
  4. Acquire distributed lock: SET matching:lock:{rideId} NX EX 30
  5. For each candidate:
       SET ride:offer:{rideId}:{driverId}  NX EX 10
       Emit Socket.IO offer → driver room
       Subscribe to Redis pub/sub: offer.response.{rideId}.{driverId}
       Await 10s (offer TTL):
         Accept → update ride status, create TripEntity, unlock
         Decline / timeout → try next candidate
  6. Radius fallback: 5km → 10km → 15km (3 rounds)
  7. No driver found → emit ride.matching.failed → notify rider
```

**Matching consumer lives in the API app** (not the worker) because it needs direct Socket.IO
access to push offers to drivers. The worker cannot emit WebSocket events.

### 5.3 Surge Pricing

```
SurgePricingCron (every 30 seconds):
  For each active region key drivers:geo:{regionId}:
    onlineDrivers  = ZCOUNT drivers:heartbeat (now-300) +inf
    activeRides    = COUNT rides WHERE status IN (MATCHING, DRIVER_ASSIGNED) AND regionId
    demandRatio    = activeRides / max(onlineDrivers, 1)

    multiplier = 1.0  (baseline)
    if demandRatio > 0.8  → multiplier = 1.5
    if demandRatio > 1.2  → multiplier = 2.0
    if demandRatio > 1.8  → multiplier = 2.5
    cap at 3.0x

    SET surge:{regionId}:default  {multiplier}  EX 60

RideService.estimateFare():
  GET surge:{regionId}:default  → no DB touch, < 1ms
```

### 5.4 Trip State Machine

```
                    ┌─────────────┐
              ┌────►│  REQUESTED  │◄────────┐
              │     └──────┬──────┘         │
              │            │ matching start  │ (idempotency replay)
              │     ┌──────▼──────┐         │
              │     │  MATCHING   │         │
              │     └──────┬──────┘         │
              │            │ driver accepts  │
              │     ┌──────▼──────────┐     │
  CANCELLED   │     │ DRIVER_ASSIGNED │     │
  (any time   │     └──────┬──────────┘     │
   with fee)  │            │ driver en route │
              │     ┌──────▼──────────┐     │
              │     │ DRIVER_ARRIVING │     │
              │     └──────┬──────────┘     │
              │            │ driver at pickup│
              │     ┌──────▼──────────┐     │
              │     │  DRIVER_ARRIVED │     │
              │     └──────┬──────────┘     │
              │            │ trip starts     │
              │     ┌──────▼──────────┐     │
              │     │  RIDE_STARTED   │     │
              │     └──────┬──────────┘     │
              │            │ trip ends       │
              │     ┌──────▼──────────┐     │
              └─────┤   COMPLETED     │     │
                    └──────┬──────────┘     │
                           │                │
                    ┌──────▼──────────┐     │
                    │ PAYMENT_PENDING │     │
                    └──────┬──────────┘     │
                           │ webhook        │
                    ┌──────▼──────────┐     │
                    │PAYMENT_COMPLETED│     │
                    └─────────────────┘     │
                                            │
                    ┌─────────────┐         │
                    │  CANCELLED  │─────────┘
                    └─────────────┘
                    ┌─────────────┐
                    │   FAILED    │
                    └─────────────┘
```

Every transition is wrapped in a PostgreSQL transaction:
1. Validate allowed transition (throw 400 if invalid)
2. `UPDATE trips SET status = new_status WHERE id = $1 AND status = $2` (optimistic lock)
3. `INSERT INTO trip_events (...)` — full audit trail
4. Emit Kafka event `trip.status.changed`
5. Emit Socket.IO event `ride:status` to rider room

### 5.5 Payment Flow

```
POST /trips/:id/complete (driver calls this)
  │
  ├── DB transaction:
  │     UPDATE trips SET status = COMPLETED
  │     INSERT trip_events (COMPLETED)
  │     INSERT payments (status=PENDING, amount=finalFare)
  │
  ├── Kafka emit: payment.charge.requested
  │
  └── HTTP 200 immediately returned

Worker PaymentConsumer:
  Consume payment.charge.requested
  Call mock PSP (90% success simulation)
  Emit payment.charge.completed OR payment.charge.failed

POST /payments/webhook (PSP calls this):
  Verify HMAC signature
  UPDATE payments SET status = COMPLETED / FAILED
  Emit notification.push.requested → notify rider
```

### 5.6 Real-Time Frontend Updates (Socket.IO)

```
Namespaces:
  /rider  → rider-facing events (ride:status, driver:location, driver:eta)
  /driver → driver-facing events (ride:offer, trip:update, dispatch)

Connection flow:
  Client connects → JWT validated in Socket.IO middleware → join room
  Rider  → joins room: ride:{rideId}
  Driver → joins room: driver:{driverId}

Events flowing to rider:
  ride:status     { rideId, status, driverId, eta }
  driver:location { lat, lng, heading }

Events flowing to driver:
  ride:offer  { rideId, pickupAddress, fare, riderId, rating }
  trip:update { status, riderId }

Multi-node WebSocket (horizontal scaling):
  All API pods share Redis pub/sub via @socket.io/redis-adapter
  An event emitted on pod-1 is received by a client connected to pod-2
```

---

## 6. Scalability Design

### Horizontal Scaling

| Component | How it scales |
|---|---|
| `apps/api` | Stateless pods — add nodes behind LB. Redis adapter handles WS fan-out |
| `apps/worker` | Add consumer instances — Kafka partitions distribute load |
| PostgreSQL | Read replicas for read-heavy queries; regional sharding via region_id |
| Redis | Cluster mode; separate instance per region; read replicas for GEO queries |
| Kafka | Increase partition count per topic; add brokers; consumer group auto-rebalance |

### Caching Strategy

| Data | Cache | TTL | Invalidation |
|---|---|---|---|
| Surge multiplier | `surge:{regionId}:default` | 60s | Cron overwrites |
| Driver status | `driver:status:{driverId}` | 300s | Explicit HSET on availability change |
| Driver GEO position | `drivers:geo:{regionId}` | Perpetual (ZREM on offline) | Stale cleanup cron |
| Idempotency results | `idempotency:{endpoint}:{key}` | 24h | TTL only |
| Refresh token hash | `session:{userId}:{deviceId}` | 7d | Explicit DEL on logout |

### Database Indexing (Hot Paths)

```sql
-- Ride lookups by rider (ride history page)
CREATE INDEX rides_rider_tenant ON rides (tenant_id, region_id, rider_id, created_at DESC);

-- Active ride lookup for a driver
CREATE INDEX rides_driver_status ON rides (tenant_id, driver_id, status)
  WHERE status NOT IN ('COMPLETED', 'CANCELLED', 'FAILED');

-- Trip lookups
CREATE INDEX trips_ride ON trips (tenant_id, ride_id);
CREATE INDEX trips_driver ON trips (tenant_id, driver_id, status);

-- Payment by trip
CREATE INDEX payments_trip ON payments (tenant_id, trip_id);

-- Idempotency key enforcement
CREATE UNIQUE INDEX rides_idempotency ON rides (tenant_id, idempotency_key);
```

### Concurrency Control

| Scenario | Mechanism |
|---|---|
| Double-assignment of driver to two rides | `SET matching:lock:{rideId} NX EX 30` distributed lock |
| Race condition on trip status update | `UPDATE trips SET status=$2 WHERE id=$1 AND status=$3` — fails if state changed |
| Duplicate payment creation | PaymentEntity has UNIQUE constraint on `(tenant_id, trip_id)` |
| Duplicate ride creation | Idempotency key with 24h Redis cache + DB UNIQUE index |

---

## 7. Kafka Event Architecture

### Topics (12 total)

```
Producer                    Topic                          Consumer(s)
──────────────────────────────────────────────────────────────────────────
RideService            →   ride.request.created       →   MatchingConsumer (API)
MatchingConsumer       →   ride.matching.failed        →   NotificationConsumer
MatchingConsumer       →   driver.assignment.created   →   TripService, NotificationConsumer
LocationService        →   driver.location.updated     →   LocationSnapshotConsumer (Worker)
TripService            →   trip.status.changed         →   NotificationConsumer
TripService            →   trip.completed              →   PaymentConsumer
PaymentService         →   payment.charge.requested    →   PSPConsumer (Worker)
PSPConsumer            →   payment.charge.completed    →   TripService, NotificationConsumer
PSPConsumer            →   payment.charge.failed       →   TripService, NotificationConsumer
Multiple               →   notification.push.requested →   FCMConsumer
Multiple               →   notification.sms.requested  →   SMSConsumer
```

### Event Envelope (all events)

```typescript
interface DomainEvent<T> {
  eventId:       string;   // uuidv4 — used for consumer deduplication
  eventType:     string;   // "ride.request.created"
  tenantId:      string;
  regionId:      string;
  correlationId: string;   // traces the original HTTP request
  timestamp:     string;   // ISO 8601
  schemaVersion: number;
  payload:       T;
}
```

### Consumer Idempotency

Every Kafka consumer checks `processed:event:{eventId}` in Redis before processing. Already-seen
events are ACKed and skipped — preventing double-payment, double-notification, etc.

---

## 8. Observability (New Relic)

### What Is Instrumented

| Signal | Tool | Detail |
|---|---|---|
| APM traces | New Relic APM | Auto-instrumented via `newrelic` module loaded at `main.ts` |
| Structured logs | Pino JSON | Every log has `{tenantId, regionId, correlationId, rideId}` |
| Slow queries | TypeORM | `maxQueryExecutionTime: 500ms` → logs + New Relic slow query |
| Correlation IDs | `CorrelationIdMiddleware` | `x-correlation-id` injected on every request, propagated to Kafka events |
| Health checks | `/health` | DB + Redis status; monitored by load balancer |

### Alert Thresholds (designed)

| Metric | Alert threshold |
|---|---|
| API p95 latency | > 500ms |
| Matching duration p95 | > 3s |
| Kafka consumer lag | > 500 messages |
| Redis GEO query | > 50ms |
| DB slow query count | > 10/min |
| Error rate | > 1% |

---

## 9. Security Design

| Concern | Implementation |
|---|---|
| Authentication | JWT access token (15m) + refresh token (7d) in HTTP-only Secure cookies |
| Token revocation | Access token jti blacklist in Redis (TTL = remaining token lifetime) |
| Refresh token security | SHA-256 hash stored in Redis; plaintext never persists; reuse detection revokes session |
| Password storage | bcrypt 12 rounds |
| Rate limiting | 5 login attempts / IP / 15min; 2 location updates / driver / sec |
| Idempotency keys | Mandatory on all side-effect endpoints; prevents double-charges |
| PSP webhook | HMAC-SHA256 signature verification before processing |
| Multi-tenancy | JWT-bound `tenantId` prevents cross-tenant data access |
| SQL injection | TypeORM parameterized queries only |

---

## 10. Failure Handling

| Failure | Detection | Recovery |
|---|---|---|
| Driver disconnects mid-ride | Socket.IO disconnect event + 30s grace timer | Mark driver OFFLINE, escalate ride to re-matching |
| Redis unavailable | Circuit breaker in ioredis | Degrade gracefully — location updates buffered, matching pauses |
| Kafka publish fails | KafkaJS retry 3× with exp backoff | After 3 failures → DLQ → alert |
| PSP timeout / failure | PaymentConsumer catches error | Retry with idempotency key — no double-charge risk |
| Driver no-response to offer | Redis key TTL 10s + pub/sub timeout | Auto-advance to next candidate |
| Stale location data | `StaleDriverCleanupService` cron (1min) | ZREM drivers older than 5 minutes |
| Duplicate ride request | Idempotency key (Redis + DB UNIQUE) | Return cached response immediately |
| Concurrent trip state write | WHERE status = expected_status check | Caller gets 409 Conflict, must retry |
| DB transaction fails mid-trip | TypeORM transaction rollback | Trip stays in previous state; Kafka event not emitted |

---

## 11. Frontend Live Updates

The frontend connects via Socket.IO and subscribes to ride events:

```
Rider opens app
  → connects to /rider namespace
  → authenticates with JWT
  → joins room: ride:{rideId}

Events received:
  ride:status      → update ride status badge
  driver:location  → update map marker in real-time
  driver:eta       → update ETA countdown

Driver opens app
  → connects to /driver namespace
  → joins room: driver:{driverId}

Events received:
  ride:offer       → show offer card (10s timer)
  trip:update      → update active trip state
```

All frontend state derives from the WebSocket stream — no polling required.

---

## 12. Deployment Topology (Local Dev via Docker Compose)

```
docker-compose.yml spins up:
  postgres:18        port 5432   → API + Worker
  redis:8            port 6379   → API + Worker
  redpanda           port 9092   → Kafka broker (Redpanda is Kafka-compatible)
  redpanda-console   port 8080   → Kafka UI for topic inspection
  pgadmin            port 5050   → DB admin UI
```

Production topology (designed for):
- API pods: Kubernetes Deployment, HPA on CPU + request rate
- Worker pods: Kubernetes Deployment, HPA on Kafka consumer lag
- PostgreSQL: AWS RDS Multi-AZ per region
- Redis: AWS ElastiCache Redis Cluster per region
- Kafka: AWS MSK or self-hosted Redpanda cluster
- Load balancer: AWS ALB with sticky sessions for WebSocket connections
