# GOComet Ride Hailing — Backend

Production-grade ride-hailing backend built at Uber/Ola scale architecture. Handles 10k ride requests/minute and 200k driver location updates/second via a hybrid modular monolith using NestJS, Kafka, Redis, and PostgreSQL.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 24 LTS |
| Framework | NestJS 11 + Fastify 5 |
| Language | TypeScript 5.8 (strict) |
| Database | PostgreSQL 18 + TypeORM 0.3 |
| Cache / GEO | Redis 8 (ioredis) |
| Message Bus | Kafka via Redpanda (KafkaJS 2) |
| Realtime | Socket.IO 4 + Redis adapter |
| Auth | JWT (15m access) + Refresh tokens (7d) |
| Monorepo | pnpm 9 + Turborepo 2 |
| Monitoring | New Relic APM + Pino structured logs |
| Containers | Docker + Docker Compose |

---

## Project Structure

```
gocomet-ride-hailing/
├── apps/
│   ├── api/          # Main NestJS HTTP + WebSocket server
│   └── worker/       # Kafka consumer workers (payments, notifications, location)
├── packages/
│   ├── common/       # Shared enums, constants, Kafka topic names
│   ├── database/     # BaseEntity (UUIDv7), TypeORM module
│   └── redis/        # Redis provider + @InjectRedis decorator
├── docker-compose.yml
├── turbo.json
└── pnpm-workspace.yaml
```

### API Modules (`apps/api/src/modules/`)

| Module | Responsibility |
|---|---|
| `auth` | JWT auth, refresh token rotation, bcrypt, rate limiting |
| `riders` | Rider profiles, payment methods |
| `drivers` | Driver profiles, vehicles, availability, Redis GEO |
| `rides` | Ride creation, fare estimation, idempotency, cancellation |
| `trips` | Full state machine with audit log (7 states) |
| `matching` | Kafka consumer → GEORADIUS → offer flow → assignment |
| `payments` | Async PSP flow, webhook handler |
| `realtime` | Socket.IO gateways for riders and drivers |
| `tenants` | Multi-tenant isolation, region management |
| `surge` | Redis-based demand pricing, 30s cron |
| `health` | DB + Redis + Kafka liveness checks |

---

## Architecture Rules (Non-Negotiable)

**1. Driver location → Redis GEO only, never PostgreSQL inline**
```
GEOADD drivers:geo:{regionId} {lng} {lat} {driverId}
```
PostgreSQL `last_location` is updated asynchronously by a Kafka consumer.

**2. Matching → Redis GEORADIUS only, never SQL**
```
ride.request.created → Kafka → MatchingConsumer → GEORADIUS → offer flow
```

**3. Trip state machine — explicit transitions, every change goes through it**
```
REQUESTED → MATCHING → DRIVER_ASSIGNED → DRIVER_ARRIVING
→ DRIVER_ARRIVED → RIDE_STARTED → COMPLETED → PAYMENT_PENDING → PAYMENT_COMPLETED
(CANCELLED / FAILED from any state)
```

**4. Payments — always async**
Trip completion emits `payment.charge.requested`. PSP is called by a worker consumer, not in the request handler.

**5. Notifications — always event-driven**
No inline FCM/SMS calls. All notifications go through `notification.*.requested` Kafka topics.

**6. Multi-tenancy — every table has `tenant_id` + `region_id`**

**7. Idempotency — mandatory for side-effect endpoints**
`POST /rides`, `POST /rides/:id/accept`, `POST /trips/:id/complete`, `POST /payments/*` all require `X-Idempotency-Key`.

**8. Writes stay region-local — no synchronous cross-region DB writes**

---

## Complete Ride Flow

```
Rider POSTs /rides
  └─► PostgreSQL (save ride, status=REQUESTED)
  └─► Kafka emit: ride.request.created  [returns 201 immediately]

MatchingConsumer reads event
  └─► Redis SET NX matching:lock:{rideId}          [distributed lock]
  └─► GEORADIUS drivers:geo:{regionId}             [find nearby drivers]
  └─► Filter by status=AVAILABLE
  └─► Rank by distance + rating
  └─► WebSocket → driver: ride:offer               [6s TTL]

Driver accepts (WebSocket: offer:response)
  └─► Redis PUBLISH offer:response:{rideId}:{driverId}
  └─► MatchingConsumer receives accept
  └─► DB transaction: INSERT trips (DRIVER_ASSIGNED) + INSERT trip_events
  └─► Kafka: trip.status.changed, notification.push.requested

Driver clicks "Arriving" → "Arrived" → "Start" → "Complete"
  └─► Each: validate transition → DB transaction → Kafka events → WebSocket push

Trip Complete
  └─► DB transaction: UPDATE trips (COMPLETED) + INSERT payments (PENDING)
  └─► Kafka: payment.charge.requested              [async PSP call by worker]
  └─► WebSocket: ride:status + ride:completed      [rider sees it live]

PaymentConsumer processes charge
  └─► Mock PSP (90% success)
  └─► POST /payments/webhook
  └─► Kafka: payment.charge.completed / failed
  └─► Notification sent to rider
```

---

## API Endpoints

### Auth
| Method | Path | Auth |
|---|---|---|
| POST | `/auth/rider/register` | Public |
| POST | `/auth/rider/login` | Public |
| POST | `/auth/driver/register` | Public |
| POST | `/auth/driver/login` | Public |
| POST | `/auth/admin/login` | Public |
| POST | `/auth/refresh` | Refresh token |
| POST | `/auth/logout` | JWT |

### Riders
| Method | Path | Auth |
|---|---|---|
| GET | `/riders/me` | RIDER |
| PATCH | `/riders/me` | RIDER |
| GET | `/riders/me/rides` | RIDER |
| GET | `/riders/me/payment-methods` | RIDER |
| POST | `/riders/me/payment-methods` | RIDER |
| POST | `/riders/me/payment-methods/:id/default` | RIDER |

### Drivers
| Method | Path | Auth |
|---|---|---|
| GET | `/drivers/me` | DRIVER |
| PATCH | `/drivers/me` | DRIVER |
| POST | `/drivers/location` | DRIVER |
| POST | `/drivers/me/availability` | DRIVER |
| POST | `/drivers/me/vehicles` | DRIVER |
| GET | `/drivers/me/vehicles` | DRIVER |
| GET | `/drivers/me/trips` | DRIVER |
| GET | `/drivers/me/earnings` | DRIVER |

### Rides
| Method | Path | Auth |
|---|---|---|
| POST | `/rides/fare-estimate` | RIDER |
| POST | `/rides` | RIDER |
| GET | `/rides/me/active` | RIDER |
| GET | `/rides/:rideId` | JWT |
| DELETE | `/rides/:rideId/cancel` | RIDER |
| GET | `/rides` | RIDER |

### Trips
| Method | Path | Auth |
|---|---|---|
| POST | `/trips/me/active` | DRIVER |
| GET | `/trips/me/active` | DRIVER |
| GET | `/trips/me/history` | DRIVER |
| GET | `/trips/:id` | JWT |
| POST | `/trips/:id/driver-arriving` | DRIVER |
| POST | `/trips/:id/driver-arrived` | DRIVER |
| POST | `/trips/:id/start` | DRIVER |
| POST | `/trips/:id/complete` | DRIVER |
| POST | `/trips/:id/cancel` | JWT |

### Payments & Admin
| Method | Path | Auth |
|---|---|---|
| GET | `/payments/:id` | JWT |
| POST | `/payments/webhook` | HMAC |
| GET | `/regions/:id/surge-map` | Public |
| POST | `/admin/tenants` | ADMIN |
| GET | `/admin/tenants` | ADMIN |
| GET | `/health` | Public |

Full interactive docs available at `http://localhost:3000/docs` (Swagger UI).

---

## WebSocket Events

### `/rider` namespace
| Event (emit) | Purpose |
|---|---|
| `join:ride` | Join a ride room to receive live updates |
| `ride:status` | Live ride status changes |
| `ride:completed` | Trip completion with final fare |
| `driver:location` | Live driver position updates |

### `/driver` namespace
| Event (emit) | Purpose |
|---|---|
| `location:update` | Send driver GPS coordinates |
| `offer:response` | Accept or decline a ride offer |
| `ride:offer` | Incoming ride offer (server → driver) |

---

## Redis Key Registry

```
drivers:geo:{regionId}           GEOADD   driver GPS coordinates (matching)
driver:status:{driverId}         HSET     { status, vehicleType, lastSeen } TTL 5m
driver:active-ride:{driverId}    SET      rideId (TTL 4h)
ride:offer:{rideId}:{driverId}   SET      offer sent to driver (TTL 6s)
matching:lock:{rideId}           SET NX   prevents double-assignment (TTL 30s)
surge:{regionId}:default         SET      surge multiplier float (TTL 60s)
idempotency:{endpoint}:{key}     SET      cached response (TTL 24h)
session:{userId}:{deviceId}      HSET     { refreshToken, issuedAt }
tenant:slug:{slug}               SET      tenantId cache (TTL 5m)
```

---

## Kafka Topics

| Topic | Producer | Consumer |
|---|---|---|
| `ride.request.created` | RideService | MatchingConsumer |
| `ride.matching.failed` | MatchingConsumer | NotificationConsumer |
| `driver.assignment.created` | MatchingConsumer | TripService, Notif |
| `driver.location.updated` | LocationService | LocationSnapshotConsumer |
| `driver.availability.changed` | DriverService | — |
| `trip.status.changed` | TripService | NotificationConsumer |
| `trip.completed` | TripService | — |
| `payment.charge.requested` | TripService | PaymentConsumer |
| `payment.charge.completed` | PaymentConsumer | Notif |
| `payment.charge.failed` | PaymentConsumer | Notif |
| `notification.push.requested` | Multiple | NotificationConsumer |
| `notification.sms.requested` | Multiple | NotificationConsumer |
| `notification.email.requested` | Multiple | NotificationConsumer |
| `*.dlq` (×16) | Error handlers | DlqConsumer |

---

## Local Development

### Prerequisites
- Node.js 24+
- pnpm 9+
- Docker + Docker Compose

### Setup

```bash
# Clone the repo
git clone https://github.com/NodeNomadKJ/goComet-backend.git
cd goComet-backend

# Install dependencies
pnpm install

# Copy env and fill in values
cp .env.example .env

# Start infrastructure (PostgreSQL, Redis, Redpanda)
docker-compose up -d

# Run migrations
pnpm --filter @gocomet/api migration:run

# Start all apps in dev mode (with watch)
pnpm dev
```

### Services after startup

| Service | URL |
|---|---|
| API | `http://localhost:3000` |
| Swagger docs | `http://localhost:3000/docs` |
| Redpanda Console | `http://localhost:8080` |
| pgAdmin | `http://localhost:5050` |

### Environment Variables

Copy `.env.example` and fill in the required values:

```bash
# App
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=gocomet
DB_PASSWORD=your_password
DB_NAME=gocomet_rides

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Kafka
KAFKA_BROKERS=localhost:19092

# Auth
JWT_SECRET=min-32-chars
JWT_REFRESH_SECRET=min-32-chars

# New Relic (optional)
NEW_RELIC_LICENSE_KEY=
NEW_RELIC_APP_NAME=gocomet-rides-dev
NEW_RELIC_ENABLED=false
```

### Useful Commands

```bash
pnpm dev                                      # Start all apps
pnpm build                                    # Build all packages
pnpm --filter @gocomet/api migration:run      # Run DB migrations
pnpm --filter @gocomet/api migration:revert   # Revert last migration
pnpm --filter @gocomet/api test               # Run unit tests
pnpm --filter @gocomet/api seed               # Seed initial tenant + region
```

---

## New Relic APM

The app ships with New Relic wired in. To enable:

1. Set `NEW_RELIC_LICENSE_KEY` and `NEW_RELIC_ENABLED=true` in `.env`
2. Restart the dev server
3. Send traffic via Swagger → APM data appears in NR within ~2 minutes

Auto-instrumented: all HTTP transactions, PostgreSQL queries, Redis operations, external HTTP calls.

---

## Performance Targets

| Metric | Target |
|---|---|
| Ride request latency P95 | < 200ms |
| Location update throughput | 200k/sec |
| Matching duration P95 | < 3s |
| Driver offer round-trip | < 1s |
| Redis GEO query latency | < 10ms |
| Kafka consumer lag | < 500 messages |
| DB query (hot paths) P95 | < 50ms |

---

## Completion Status

```
Phase 1 — Core Backend       ████████████  100%   Auth, Riders, Drivers, Rides
Phase 2 — Realtime           ████████████  100%   Socket.IO, Location Pipeline
Phase 3 — Matching Engine    ████████████  100%   GEORADIUS, Offer Flow, Trip FSM
Phase 4 — Async Events       ████████████  100%   Kafka, Payments, Notifications
Phase 5 — Scale & Ops        ████████████  100%   Multi-tenancy, Surge, Observability
```
