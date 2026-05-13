---
name: progress-notes
description: Session-by-session implementation notes, surprises, and decisions made during development
metadata:
  type: project
---

# Progress Notes — GOComet Ride Hailing

Use this file to record non-obvious decisions, unexpected issues, and context that
won't be obvious from reading the code later. Update after every significant session.

## Template (copy for each session)

```
## Session: YYYY-MM-DD

**Phase/Module:** 
**What was implemented:**
**Decisions made (and why):**
**Deviations from CLAUDE.md (and justification):**
**Issues encountered:**
**What's next:**
```

---

## Session: 2026-05-12 (Initial Setup)

**Phase/Module:** Project setup — CLAUDE.md, skills, progress tracker

**What was implemented:**
- Full .claude/ directory structure with CLAUDE.md, 17 skills, memory files, progress tracker
- Architecture finalized from analysis of Uber/Ola-scale requirements

**Decisions made:**
- Chose NestJS + Fastify over Express: Fastify is ~2x faster, has built-in schema validation
- Chose TypeORM over Prisma: TypeORM's QueryBuilder is better for complex composite queries at scale
- Chose Redpanda over bare Kafka: Redpanda starts in <5s locally vs Kafka's 30s+ with Zookeeper
- Chose pnpm + Turborepo monorepo: faster installs, built-in caching for CI/CD
- Chose shared-DB multi-tenancy: operationally simpler than DB-per-tenant at this scale

**Deviations from initial plan:** None at this stage

**Issues encountered:** None — this session was planning/setup only

**What's next:** Run `/setup-monorepo` to initialize the actual codebase

---

<!-- Add new sessions below as development progresses -->
