# /update-progress

Scan the codebase and update PROJECT_PROGRESS.md to reflect actual implementation state.
Run this at the end of every work session.

## Instructions

Perform the following checks and update PROJECT_PROGRESS.md accordingly:

### 1. Check Infrastructure Setup
Run these checks:
- Does `docker-compose.yml` exist with postgres, redis, redpanda services?
- Does `packages/database/src/base.entity.ts` exist?
- Does `apps/api/src/main.ts` use FastifyAdapter?
- Does `GET /health` endpoint exist?

### 2. Check Auth Module
- Does `apps/api/src/modules/auth/auth.service.ts` exist?
- Grep for `registerRider`, `registerDriver`, `refreshTokens`, `logout`
- Does `apps/api/src/modules/auth/strategies/jwt.strategy.ts` exist?
- Does `apps/api/src/modules/auth/guards/roles.guard.ts` exist?
- Does `auth.service.spec.ts` exist with at least 5 test cases?

### 3. Check Rider Module
- Does `apps/api/src/modules/rider/rider.service.ts` exist?
- Does `packages/database/src/entities/rider.entity.ts` exist?
- Grep for `getRideHistory`, `addPaymentMethod`

### 4. Check Driver Module
- Does `apps/api/src/modules/driver/driver-availability.service.ts` exist?
- Grep for `GEOADD` in driver code — must exist (Redis GEO usage)
- Grep for `UPDATE drivers SET lat` — must NOT exist (PostgreSQL direct location update forbidden)

### 5. Check Ride Request
- Does `apps/api/src/modules/ride/fare.service.ts` exist?
- Does `apps/api/src/modules/ride/idempotency.service.ts` exist?
- Grep for `X-Idempotency-Key` in ride controller

### 6. Check Realtime
- Does `apps/api/src/modules/realtime/rider.gateway.ts` exist?
- Does `apps/api/src/adapters/redis-io.adapter.ts` exist?
- Grep for `RedisIoAdapter` in main.ts

### 7. Check Location Tracking
- Does `apps/api/src/modules/location/location.service.ts` exist?
- Grep for `GEOADD` in location service
- Grep for `eachBatch` in worker consumers (batch processing)

### 8. Check Matching Engine
- Does `apps/worker/src/modules/matching/matching.service.ts` exist?
- Grep for `GEORADIUS` — must be in matching, not in ride service
- Grep for `matching:lock:` — distributed lock must be present
- Grep for `SELECT.*driver.*nearest` — must NOT exist (no DB matching queries)

### 9. Check Trip State Machine
- Does `apps/api/src/modules/trip/trip-state.service.ts` exist?
- Grep for `ALLOWED_TRANSITIONS` map
- Does `apps/api/src/modules/trip/entities/trip-event.entity.ts` exist?
- Grep for `pessimistic_write` — optimistic locking on trip transitions required

### 10. Check Kafka Events
- Does `packages/kafka/src/constants/kafka-topics.constants.ts` exist?
- Grep for `BaseConsumer` — all consumers must extend this
- Grep for `isProcessed` — idempotency check must be present

### 11. Check Payment
- Does `apps/api/src/modules/payment/psp/psp.interface.ts` exist?
- Grep for `await pspClient` in controllers — must NOT exist (no inline PSP calls)
- Does webhook endpoint exist with HMAC verification?

### 12. Check Notifications
- Does `apps/worker/src/modules/notification/consumers/push.consumer.ts` exist?
- Grep for `await fcm.send` in controllers/services — must NOT exist (must be async)

### 13. Check Multi-Tenant
- Does `apps/api/src/modules/tenant/middleware/tenant.middleware.ts` exist?
- Grep for `tenantId` in TypeORM queries — spot check 3 services

### 14. Check Surge Pricing
- Does `apps/worker/src/modules/surge/surge.cron.ts` exist?
- Grep for `surge:${regionId}` in redis operations
- Grep for `getSurgeForLocation` in fare service integration

### 15. Check Observability
- Does `newrelic.js` exist at project root?
- Does `packages/observability/src/pino-logger.service.ts` exist?
- Does correlation ID middleware exist?

## Update Rules

For each check:
- Found and correct → mark `[x]` in PROJECT_PROGRESS.md
- Missing → keep `[ ]`

Update:
1. Phase completion percentages
2. Overall completion bar
3. Database Tables Tracker (check migrations directory)
4. Kafka Topics Tracker (check topic constants)
5. API Endpoints Tracker (check controllers)
6. Completion Log: add today's date + summary of what was done

## Architecture Violations to Flag

If you find any of these, add them to "Known Issues / Architectural Deviations":

1. `UPDATE drivers SET.*lat.*lng` in a service file → Rule 1 violation
2. `SELECT.*FROM drivers WHERE ST_Distance` → Rule 2 violation
3. `trip.status =` assignment without going through TripStateService → Rule 3 violation
4. `await pspService.charge` in a controller or trip service → Rule 4 violation
5. `await fcm.send` or `await smsService.send` in a non-consumer file → Rule 5 violation
6. Any entity without `tenantId` and `regionId` columns → Rule 6 violation
7. Any POST/payment endpoint without idempotency key handling → Rule 7 violation

## Output Format

After completing the scan, output a summary like:

```
## Progress Update — YYYY-MM-DD

Phase 1 (Core Backend):   X/5 complete [██████████░░░░░░░░░░] 60%
Phase 2 (Realtime):       X/2 complete [████░░░░░░░░░░░░░░░░] 50%
Phase 3 (Matching):       X/2 complete [░░░░░░░░░░░░░░░░░░░░] 0%
Phase 4 (Async/Events):   X/3 complete [░░░░░░░░░░░░░░░░░░░░] 0%
Phase 5 (Scale/Ops):      X/3 complete [░░░░░░░░░░░░░░░░░░░░] 0%

Overall: X% complete
Architecture violations: [list any found]
Next recommended step: [first unchecked item in current phase]
```
