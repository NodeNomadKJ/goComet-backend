---
name: tech-stack
description: Final technology choices, versions, and rationale for GOComet platform
metadata:
  type: project
---

# Tech Stack — GOComet Ride Hailing

## Locked-In Choices (do not change without updating CLAUDE.md)

| Layer | Choice | Version | Rationale |
|-------|--------|---------|-----------|
| Runtime | Node.js | 24 LTS | Latest LTS (Oct 2025+), V8 perf improvements |
| Framework | NestJS + Fastify | NestJS 11, Fastify 5 | DI + module system + 2x Express throughput |
| Language | TypeScript | 5.8+ strict | Strict mode prevents runtime surprises |
| DB | PostgreSQL | 18 | Latest stable (Sep 2025+), ACID, JSONB, PostGIS-ready |
| ORM | TypeORM | 0.3.x | Migrations, QueryBuilder, decorators |
| Cache | Redis | 8 via ioredis 5 | Latest LTS, GEO commands, Streams, pub/sub |
| Events | KafkaJS 2 + Redpanda | Redpanda locally | Kafka API compatible, faster local startup |
| Realtime | Socket.IO + @socket.io/redis-adapter | v4 / adapter v8 | Multi-node, rooms, namespaces |
| Auth | JWT (jsonwebtoken) + Passport | — | Access 15m + Refresh 7d |
| Logging | Pino + pino-pretty | v9+ | Fastest Node.js logger, structured JSON |
| Monitoring | New Relic APM Node.js agent | latest | Required by project spec |
| Validation | class-validator + class-transformer | — | NestJS native, plays well with pipes |
| Testing | Jest + Supertest | — | NestJS default, well-documented |
| Container | Docker + Docker Compose | v3.8 | Local dev only |
| Monorepo | pnpm + Turborepo | pnpm 9, Turborepo 2 | Fast installs, incremental builds |
| Reverse Proxy | Nginx | 1.27 | Simple config for local multi-app routing |

## What Was Rejected and Why

| Rejected | Alternative Chosen | Reason |
|----------|-------------------|--------|
| Express | Fastify | Express is ~40% slower, no built-in schema validation |
| Prisma | TypeORM | Prisma migration workflow less flexible for complex composite indexes |
| RabbitMQ | Kafka/Redpanda | Kafka provides replay, partitioning, consumer groups; RabbitMQ has no replay |
| MongoDB | PostgreSQL | ACID transactions required for payment + trip state machine |
| Mongoose | TypeORM | Follows from MongoDB rejection |
| gRPC (internal) | REST | Team familiarity, Swagger documentation, simpler for Phase 1 |
| Kubernetes (local) | Docker Compose | k8s locally (minikube) too heavy for dev. Docker Compose is sufficient |
| Drizzle | TypeORM | Drizzle lacks migration tooling maturity as of 2026 |
| native ws | Socket.IO | Socket.IO provides rooms, namespaces, Redis adapter out of box |
| OAuth/Auth0 | Custom JWT | External auth adds vendor dependency; JWT is sufficient for this use case |

## Dependency Notes

- Use `ioredis` not `redis` (node-redis) — ioredis has better cluster, pipeline, and GEO support
- Use `@socket.io/redis-adapter` (v8) not `socket.io-redis` (deprecated)
- Use `kafkajs` not `node-rdkafka` — pure JS, easier Docker setup
- Use `@nestjs/platform-fastify` (Fastify 5) not `@nestjs/platform-express`
- Use Redpanda for local Kafka — starts in <5s vs Kafka's 30s+ with Zookeeper

## Version Pinning Strategy

Pin major versions in package.json. Do not use `^` for:
- TypeORM (breaking changes between minor versions)
- KafkaJS (consumer group changes)
- Socket.IO (protocol changes)

Use `^` is acceptable for:
- Pino, class-validator, class-transformer
- NestJS ecosystem packages (they release together)
