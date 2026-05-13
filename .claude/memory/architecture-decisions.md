---
name: architecture-decisions
description: 8 locked-in architectural rules for the GOComet ride-hailing platform with justification
metadata:
  type: project
---

# Architecture Decisions — GOComet Ride Hailing

These are FINALIZED decisions. Do not re-litigate them unless there is a new constraint.

## Decision 1: Hybrid Modular Monolith, Not Full Microservices

**Decision:** Start as one deployable backend, modular internally. Extract only when needed (matching, payments).

**Why:** At 10k req/min + 200k location updates/sec, the bottleneck is geo indexing, Redis pressure,
and Kafka throughput — not service decomposition. Premature split into 20 services creates distributed
transaction nightmares and local dev pain. Uber started monolithic.

**How to apply:** All modules live in apps/api. Matching and payment workers live in apps/worker.
Only extract to independent services when a module's scaling needs diverge from the monolith.

---

## Decision 2: Driver Location — Redis GEO, Never PostgreSQL

**Decision:** Real-time driver locations are stored ONLY in Redis GEO sets. PostgreSQL stores only
the last-known-location snapshot, updated asynchronously via Kafka consumer.

**Why:** 100k drivers × 2 updates/sec = 200k writes/sec. PostgreSQL dies immediately at this rate
if used naively. Redis GEOADD is O(log N) and handles this effortlessly in memory.

**How to apply:** Every location update goes: HTTP → Redis GEO → Kafka event → (async) PostgreSQL snapshot.
grep for "UPDATE drivers SET.*lat" — this should never exist in the codebase.

---

## Decision 3: Matching — In-Memory Event-Driven Only

**Decision:** Driver matching uses Kafka consumer + Redis GEORADIUS. Zero PostgreSQL queries during matching.

**Why:** Under 10k ride requests/min with spatial SQL queries (ST_Distance), PostgreSQL becomes the bottleneck
within minutes. Redis GEORADIUS is O(N+log M) and executes in <5ms.

**How to apply:** Matching consumer reads from Redis exclusively. Any "SELECT FROM drivers WHERE nearest"
is an architecture violation.

---

## Decision 4: Trip = Explicit State Machine

**Decision:** TripStatus enum has 11 states. Transitions validated by TripStateService.ALLOWED_TRANSITIONS map.
Every transition: validate → DB transaction + TripEvent audit log → Kafka event → Socket.IO push.

**Why:** Without explicit state machine, ad-hoc status updates lead to impossible states (e.g., completed
before started, payment before trip). Every bug in production on Uber-scale systems traced back to missing
state validation.

**How to apply:** TripStateService.validateTransition() MUST be called before any trip status change.
Pessimistic DB lock prevents race conditions.

---

## Decision 5: Payments — Always Async

**Decision:** Trip completion emits payment.charge.requested Kafka event. PSP is called by worker consumer.
Result comes back via PSP webhook or consumer retry.

**Why:** PSP calls can take 2-10 seconds, occasionally hang, and fail with transient errors. Blocking
the rider's trip completion on PSP introduces latency and failure modes into the critical path.

**How to apply:** pspService.charge() should NEVER be called from apps/api. Only from apps/worker consumers.

---

## Decision 6: Notifications — Always Event-Driven

**Decision:** All notifications (FCM push, SMS, email) are sent via Kafka consumers only.

**Why:** FCM can have 1-3s latency. SMS providers rate-limit. Inline sends fail the request on provider outage.
Decoupling via Kafka gives retry, DLQ, and failure isolation.

**How to apply:** fcmChannel.send() and twilioChannel.send() should only appear in apps/worker consumers.

---

## Decision 7: Multi-Tenancy — Shared DB Shared Schema

**Decision:** Single PostgreSQL database. Every table has tenant_id + region_id columns. Row-level isolation
via WHERE clauses. Tenant resolved from request header or subdomain.

**Why:** DB-per-tenant is operationally complex at scale (10+ tenants = 10+ DBs to migrate, monitor, backup).
Shared schema with composite indexes is the standard approach used by Stripe, Shopify, etc.

**How to apply:** BaseEntity includes tenantId + regionId. TenantMiddleware resolves tenant and attaches to request.
All queries include WHERE tenantId = ? — enforced via TypeORM interceptor in Phase 5.

---

## Decision 8: Writes Stay Region-Local

**Decision:** Each region (Bangalore, Mumbai, Dubai) owns its data. Cross-region sync is async via Kafka.
No synchronous cross-region DB writes.

**Why:** Cross-region DB writes require global transaction locks, increase latency, and create hard dependency
on network between data centers. Mumbai traffic should not be affected by a Bangalore DB issue.

**How to apply:** region_id is on every entity. Queries are always scoped to one region. If data needs to
be shared across regions (e.g., driver moving between regions), it flows through Kafka events.
