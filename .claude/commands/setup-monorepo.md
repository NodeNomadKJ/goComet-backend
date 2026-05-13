# /setup-monorepo

Set up the complete GOComet ride-hailing monorepo from scratch. This is Phase 1, Step 0.
Do NOT proceed unless the working directory is the project root.

## What to Build

### 1. Root Monorepo Config

Initialize pnpm workspace with Turborepo:

```
gocomet-ride-hailing/
├── apps/
│   ├── api/               ← Main NestJS + Fastify app
│   └── worker/            ← Kafka consumers app (NestJS)
├── packages/
│   ├── common/            ← Shared types, enums, constants, interfaces
│   ├── database/          ← TypeORM entities, migrations, seeds
│   └── redis/             ← Redis provider NestJS module
├── docker/
│   ├── postgres/
│   │   └── init.sql
│   └── redpanda/
│       └── redpanda.yaml
├── docker-compose.yml
├── docker-compose.override.yml   ← local dev overrides
├── turbo.json
├── pnpm-workspace.yaml
├── package.json                  ← root
├── tsconfig.base.json
├── .env.example
├── .env                          ← gitignored
└── .gitignore
```

### 2. pnpm-workspace.yaml

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### 3. turbo.json

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "dev": { "persistent": true, "cache": false },
    "test": { "dependsOn": ["^build"] },
    "lint": {}
  }
}
```

### 4. tsconfig.base.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "resolveJsonModule": true,
    "baseUrl": ".",
    "paths": {}
  }
}
```

### 5. apps/api — NestJS Bootstrap

Use `@nestjs/cli` to scaffold. Use Fastify adapter:

```typescript
// apps/api/src/main.ts
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
  );

  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  const config = new DocumentBuilder()
    .setTitle('GOComet Ride Hailing API')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
bootstrap();
```

### 6. packages/database — BaseEntity

```typescript
// packages/database/src/base.entity.ts
import {
  PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  regionId: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ default: false })
  isDeleted: boolean;
}
```

### 7. packages/redis — Redis Module

```typescript
// packages/redis/src/redis.module.ts
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService) => {
        const redis = new Redis({
          host: config.get('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get('REDIS_PASSWORD'),
          retryStrategy: (times) => Math.min(times * 100, 3000),
          maxRetriesPerRequest: 3,
        });
        redis.on('error', (err) => console.error('Redis error:', err));
        return redis;
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
```

### 8. packages/common — Shared Enums

Create these enums in packages/common/src/enums/:
- RideStatus
- TripStatus
- DriverStatus
- VehicleType
- UserRole
- PaymentStatus
- NotificationType

### 9. docker-compose.yml

Services to include:
- **postgres**: postgres:15-alpine, port 5432, volume for data persistence, init.sql creates DB + extensions (uuid-ossp, postgis if available)
- **redis**: redis:7-alpine, port 6379, --appendonly yes
- **redpanda**: vectorized/redpanda, ports 9092 (kafka), 9644 (admin), 8080 (console)
- **redpanda-console**: redpandadata/console, port 8080, auto-discovers topics
- **pgadmin**: dpage/pgadmin4, port 5050, for local DB browsing

All services on a shared `gocomet-network` bridge network.

### 10. .env.example

```env
# App
PORT=3000
NODE_ENV=development

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=gocomet
DB_PASSWORD=gocomet_dev
DB_NAME=gocomet_rides
DB_SYNC=false
DB_LOGGING=true

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Kafka
KAFKA_BROKERS=localhost:9092
KAFKA_CLIENT_ID=gocomet-api
KAFKA_GROUP_ID=gocomet-consumers

# Auth
JWT_SECRET=change-me-in-production-use-256bit
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# New Relic
NEW_RELIC_LICENSE_KEY=
NEW_RELIC_APP_NAME=gocomet-rides-dev
NEW_RELIC_ENABLED=false
```

### 11. Health Check

Implement `GET /health` that checks:
- PostgreSQL connection (simple SELECT 1)
- Redis PING
- Returns `{ status: 'ok', postgres: 'up', redis: 'up' }`

### 12. Apps/worker Bootstrap

Mirror of apps/api but NestJS application type (not HTTP), no Fastify, just Kafka consumers.

## After Setup

Run `docker-compose up -d` and verify:
- Postgres accessible at localhost:5432
- Redis accessible at localhost:6379
- Redpanda console at http://localhost:8080
- pgAdmin at http://localhost:5050
- API health check at http://localhost:3000/health → `{"status":"ok"}`
- Swagger UI at http://localhost:3000/docs

## Update Progress

After completing, check off in PROJECT_PROGRESS.md:
- All items under "Infrastructure Setup /setup-monorepo"
- Add completion date to Completion Log
