---
name: coding-standards
description: TypeScript, NestJS, and domain patterns to follow consistently across the codebase
metadata:
  type: project
---

# Coding Standards — GOComet Ride Hailing

## TypeScript

- `strict: true` always — no exceptions
- No `any` type — use `unknown` and narrow, or define proper interface
- No `@ts-ignore` without a comment explaining why
- Prefer `interface` for DTOs and external contracts
- Use `class` for NestJS services, entities, and things with decorators
- Use `enum` for status fields and constants that appear in DB or Kafka events
- Use `const enum` only for code-only constants (not persisted)
- Prefer `readonly` on DTO properties and service constructor injections

## NestJS Module Pattern

Every domain follows this structure, no exceptions:
```
modules/{domain}/
  {domain}.module.ts      ← @Module decorator
  {domain}.controller.ts  ← HTTP routes only, no business logic
  {domain}.service.ts     ← all business logic, no HTTP concerns
  dto/                    ← class-validator decorated DTOs
  entities/               ← TypeORM entities
  events/                 ← Kafka event type definitions
  exceptions/             ← HttpException subclasses
  tests/                  ← *.spec.ts files
```

Controllers are thin — they validate input via pipes and delegate to services. Zero business logic in controllers.

## Response Format (always consistent)

Single object:
```json
{ "data": {...}, "meta": { "timestamp": "...", "correlationId": "..." } }
```

Paginated list:
```json
{ "data": [...], "meta": { "total": 0, "page": 1, "limit": 20, "totalPages": 0 } }
```

Error:
```json
{ "statusCode": 400, "message": "...", "correlationId": "...", "timestamp": "..." }
```

## Exception Pattern

Always use domain-specific exceptions, never throw `new Error()` directly:
```typescript
// Wrong:
throw new Error('Ride not found');

// Right:
throw new RideNotFoundException(rideId);
```

Every module has an `exceptions/` directory with one file.

## Logging Pattern

Always log with structured context. Never use `console.log`.

```typescript
// Wrong:
console.log('Processing ride', rideId);
this.logger.log('Processing ride');

// Right:
this.logger.log('Processing ride request', { rideId, tenantId, riderId, correlationId });
```

Log levels:
- `error` — unrecoverable failures, unexpected exceptions
- `warn` — recoverable issues, DLQ sends, rate limit hits
- `log/info` — significant business events (ride created, driver assigned, payment completed)
- `debug` — verbose operational details (only in development)

## Naming Conventions

- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Methods/properties: `camelCase`
- Constants/enums: `UPPER_SNAKE_CASE` for values, `PascalCase` for types
- Kafka topics: `domain.entity.action` (e.g., `ride.request.created`)
- Redis keys: `noun:scope:id` (e.g., `driver:status:uuid`)
- DTOs: suffix `Dto` (e.g., `CreateRideDto`, `RideResponseDto`)
- Entities: suffix `Entity` (e.g., `RideEntity`)
- Events: suffix `Event` or `Payload` for Kafka types

## Database Patterns

- All entities extend `BaseEntity` (id, tenantId, regionId, createdAt, updatedAt, isDeleted)
- Soft delete: `isDeleted = true`, never hard delete
- Migrations for all schema changes — never use `synchronize: true` in production
- Use `QueryBuilder` for multi-join queries, `findOne/find` for simple lookups
- Always include `tenantId` in WHERE clauses
- Pessimistic write lock for state machine transitions: `lock: { mode: 'pessimistic_write' }`

## Testing Standards

Unit tests:
- Test service methods in isolation
- Mock external dependencies (Redis, DB, Kafka, PSP)
- Test failure paths as thoroughly as happy paths
- Use `describe` blocks per method

Integration tests:
- Use Testcontainers for PostgreSQL and Redis (real containers, not mocks)
- Test full API request → DB → response
- Run in CI, not local only

What NOT to test:
- NestJS DI wiring (that's framework testing)
- TypeORM entity definitions (test the queries, not the decorators)
- DTO validation (test the decorator behavior, not class-validator internals)

## Kafka Consumer Pattern

Every consumer:
1. Extends `BaseConsumer<PayloadType>`
2. Implements `handle(event: DomainEvent<T>): Promise<void>`
3. Is idempotent (BaseConsumer handles dedup via ProcessedEventsService)
4. Never `console.log`s — uses injected logger
5. Re-throws infrastructure errors (Redis down, DB down) to trigger BaseConsumer retry
6. Catches and returns for business-logic "non-errors" (e.g., duplicate payment already processed)

## Redis Usage

- Always use `pipeline()` when making 2+ sequential commands in one operation
- Always set TTL on every key — no infinite-lived keys
- Key naming: must follow the registry in CLAUDE.md Redis Key Patterns section
- Never store sensitive data (PII, payment details) in Redis — it's not encrypted
- Use `HSET`/`HGET` for struct-like data, `SET`/`GET` for scalar values

## Security

- Never log passwords, tokens, card numbers — use Pino's `redact` config
- Never store plaintext passwords — bcrypt with 12 rounds minimum
- JWT secrets from env vars only, never hardcoded
- PSP tokens stored at PSP side — we store only opaque token reference
- Validate all UUIDs with `ParseUUIDPipe` in controllers
- HMAC-verify all PSP webhooks before processing
