# /review-implementation

Perform a thorough architecture compliance audit of the current codebase.
Run before marking any phase as complete.

## Audit Checklist

### CRITICAL Rules Audit (any failure = do not proceed)

**Rule 1: Driver Location — Redis Only**
```
grep -r "UPDATE drivers SET.*lat" apps/ → must return NOTHING
grep -r "INSERT INTO location_history" apps/ → must return NOTHING
grep -r "GEOADD.*drivers:geo" apps/ → must return results in location/driver services
```

**Rule 2: Matching — No DB Queries**
```
grep -r "ST_Distance\|ST_Within\|nearest.*driver\|SELECT.*driver.*WHERE" apps/worker/src/modules/matching/ → must return NOTHING
grep -r "GEORADIUS\|georadius" apps/worker/src/modules/matching/ → must return results
```

**Rule 3: Trip State Machine**
```
grep -r "trip\.status\s*=" apps/ → every result must be inside trip-state.service.ts or executeTransition
grep -r "ALLOWED_TRANSITIONS" apps/ → must exist in trip-state.service.ts
grep -r "validateTransition" apps/ → must be called before every trip DB update
```

**Rule 4: Payment Async**
```
grep -r "pspService\.\|stripeService\.\|razorpay\." apps/api/src/modules/ → must return NOTHING (PSP only in worker)
grep -r "payment.charge.requested" apps/ → must be emitted, not awaited in request path
```

**Rule 5: Notifications Async**
```
grep -r "fcm\.\|twilio\.\|smsService\." apps/api/src/ → must return NOTHING
grep -r "notification\.push\.requested\|notification\.sms\.requested" apps/ → must be Kafka emits
```

**Rule 6: tenant_id + region_id**
```
grep -r "@Entity" packages/database/src/entities/ → check each entity has tenantId + regionId
grep -r "extends BaseEntity" → all entities must extend BaseEntity
```

**Rule 7: Idempotency**
```
grep -r "X-Idempotency-Key\|idempotency-key\|idempotencyKey" apps/api/src/modules/ride/ → must exist in controller
grep -r "idempotencyService\.\|IdempotencyService" apps/api/src/modules/trip/ → must exist in completeTrip
```

**Rule 8: Region-Local Writes**
```
grep -r "cross.*region\|crossRegion" apps/ → verify no synchronous cross-region writes
```

### Code Quality Audit

**TypeScript Strict Compliance**
```
grep -r ": any\b" apps/ packages/ --include="*.ts" → must return NOTHING (use unknown instead)
grep -r "@ts-ignore" apps/ packages/ → document each occurrence
grep -r "as any" apps/ packages/ --include="*.ts" → must return NOTHING
```

**No Raw SQL in Services**
```
grep -r "\.query(\`" apps/api/src/modules/ → verify only in health check or migration
grep -r "QueryBuilder" apps/ → verify complex queries use QueryBuilder, not raw SQL
```

**Error Handling**
```
grep -r "throw new Error(" apps/api/src/modules/ → each should be a domain exception
grep -r "console\.log\|console\.error" apps/ → must return NOTHING (use Pino logger)
```

**No Circular Dependencies**
```
npx madge --circular apps/api/src → must return no circular dependencies
```

### Performance Patterns Audit

**Redis Pipeline Usage**
```
grep -r "this\.redis\." apps/ --include="*.ts" | grep -v "pipeline\|exec" | grep -v "spec" | wc -l
```
If more than 2 sequential Redis calls in a single method → suggest using pipeline.

**Kafka Event Fire-and-Forget Pattern**
```
grep -r "await.*kafkaProducer\.emit" apps/api/src/ → in hot paths (location, ride creation) should NOT await
grep -r "kafkaProducer\.emit(" apps/api/src/modules/location/ → should be: this.kafka.emit(...).catch(...)
```

**Missing Indexes**
Check each entity's @Index decorators match these requirements:
- rides: (tenantId, regionId, status), (riderId, status)
- trips: (tenantId, regionId, status), (driverId, status)
- drivers: (tenantId, regionId, status)
- payments: (tenantId, tripId)

### Security Audit

**Auth Coverage**
```
grep -r "@UseGuards" apps/api/src/modules/ → every controller must have JwtAuthGuard
grep -r "@Roles" apps/api/src/modules/ → admin endpoints must have @Roles(UserRole.ADMIN)
grep -r "select: false" apps/ → passwordHash field must have select: false
```

**No Secrets in Code**
```
grep -r "sk_live_\|sk_test_\|password.*=.*['\"]" apps/ packages/ → must return NOTHING
```

**Input Validation**
```
grep -r "class.*Dto" apps/ --include="*.ts" | wc -l  → count DTOs
grep -r "@Is\|@Min\|@Max\|@IsEnum" apps/ --include="*.ts" | wc -l  → count validators
```
Ratio of validators to DTOs should be > 3 (most DTOs have multiple validators).

**Webhook HMAC Verification**
```
grep -r "verifyWebhookSignature\|stripe-signature\|webhook.*secret" apps/api/src/modules/payment/ → must exist
```

### Test Coverage Audit

```
find apps/ packages/ -name "*.spec.ts" | wc -l  → count test files
find apps/ packages/ -name "*.service.ts" | wc -l  → count service files
```
Every service file should have a corresponding .spec.ts file.

```
npx jest --coverage --coverageReporters=text-summary 2>&1 | tail -20
```
Report coverage. Target: > 70% statement coverage on business logic modules.

### Docker / Infrastructure Audit

```
docker-compose config --quiet → validate docker-compose.yml syntax
grep -r "healthcheck" docker-compose.yml → postgres and redis should have health checks
grep -r "restart: unless-stopped" docker-compose.yml → all services should auto-restart
```

## Scoring

After all checks, produce a score:

```
CRITICAL Rules:  _/8 passing
Code Quality:    _/5 passing
Performance:     _/4 passing
Security:        _/5 passing
Test Coverage:   _% statement

OVERALL READINESS: [PASS/FAIL]
```

**FAIL** if any CRITICAL rule fails.
**FAIL** if test coverage < 50%.
**PASS** if all CRITICAL rules pass and coverage ≥ 50%.

## Output

Provide:
1. Score breakdown
2. List of all violations found with file paths + line numbers
3. Prioritized fix list (CRITICAL → HIGH → MEDIUM)
4. Estimated effort to fix each violation
