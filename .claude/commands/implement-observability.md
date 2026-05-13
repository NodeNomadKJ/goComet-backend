# /implement-observability

Implement full-stack observability: New Relic APM, Pino structured logging, correlation IDs,
custom metrics, health checks, and alert policies.
Prerequisite: Phase 4 complete.

## What to Build

### File Structure

```
apps/api/src/
  common/
    middleware/
      correlation-id.middleware.ts
    interceptors/
      logging.interceptor.ts
      metrics.interceptor.ts
    filters/
      all-exceptions.filter.ts
    health/
      health.controller.ts
      health.service.ts

packages/observability/
  src/
    observability.module.ts
    pino-logger.service.ts
    newrelic.service.ts         ← custom metrics wrapper
    metrics.constants.ts

newrelic.js                     ← root (required by New Relic)
```

### New Relic Configuration

```javascript
// newrelic.js (must be at project root, loaded before app)
'use strict';
exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  logging: { level: 'warn' },
  allow_all_headers: true,
  distributed_tracing: { enabled: true },
  transaction_tracer: {
    enabled: true,
    transaction_threshold: 0.2,  // trace transactions > 200ms
    record_sql: 'obfuscated',
  },
  slow_sql: { enabled: true },
  error_collector: { enabled: true, ignore_status_codes: [401, 403, 404] },
  custom_attributes: { enabled: true },
};
```

Bootstrap (main.ts — MUST be first line):
```typescript
// main.ts — MUST be before any other import
if (process.env.NEW_RELIC_ENABLED === 'true') require('newrelic');
```

### Pino Logger Service

```typescript
// packages/observability/src/pino-logger.service.ts
@Injectable()
export class PinoLoggerService implements LoggerService {
  private logger: pino.Logger;

  constructor() {
    this.logger = pino({
      level: process.env.LOG_LEVEL ?? 'info',
      ...(process.env.NODE_ENV === 'development' ? {
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } },
      } : {}),
      formatters: {
        level: (label) => ({ level: label }),
        bindings: () => ({ service: process.env.SERVICE_NAME ?? 'gocomet-api', env: process.env.NODE_ENV }),
      },
      serializers: {
        err: pino.stdSerializers.err,
        req: (req) => ({ method: req.method, url: req.url, id: req.id }),
      },
      redact: ['req.headers.authorization', 'req.headers.cookie', 'password', 'passwordHash'],
    });
  }

  log(message: string, context?: Record<string, unknown>) {
    this.logger.info(context ?? {}, message);
  }

  error(message: string, context?: Record<string, unknown>) {
    this.logger.error(context ?? {}, message);
  }

  warn(message: string, context?: Record<string, unknown>) {
    this.logger.warn(context ?? {}, message);
  }

  debug(message: string, context?: Record<string, unknown>) {
    this.logger.debug(context ?? {}, message);
  }

  child(bindings: Record<string, unknown>): PinoLoggerService {
    return Object.assign(Object.create(this), { logger: this.logger.child(bindings) });
  }
}
```

### Correlation ID Middleware

```typescript
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: FastifyRequest, res: FastifyReply, next: () => void) {
    const correlationId = (req.headers['x-correlation-id'] as string) ?? uuidv4();
    (req as any).correlationId = correlationId;
    res.header('x-correlation-id', correlationId);
    // Attach to async context for log propagation
    als.run({ correlationId }, next);
  }
}
```

Use `AsyncLocalStorage` to propagate correlationId through async calls without passing explicitly.

### Logging Interceptor

```typescript
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const { method, url, correlationId } = req;
    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start;
        this.logger.log(`${method} ${url} ${context.switchToHttp().getResponse().statusCode} ${duration}ms`, {
          correlationId, duration, method, url,
          tenantId: req.user?.tenantId,
          userId: req.user?.sub,
        });
        // New Relic custom attribute
        newrelic.addCustomAttribute('correlationId', correlationId);
        newrelic.addCustomAttribute('tenantId', req.user?.tenantId ?? '');
      }),
      catchError((err) => {
        this.logger.error(`${method} ${url} ERROR`, {
          correlationId, method, url, err: err.message, stack: err.stack,
          tenantId: req.user?.tenantId,
        });
        throw err;
      }),
    );
  }
}
```

### Custom Metrics Service

```typescript
// packages/observability/src/newrelic.service.ts
@Injectable()
export class NewRelicService {
  recordRideRequestLatency(ms: number) {
    newrelic.recordMetric('Custom/ride/request_latency_ms', ms);
  }

  recordMatchingDuration(ms: number) {
    newrelic.recordMetric('Custom/matching/duration_ms', ms);
  }

  recordLocationUpdateCount(count: number) {
    newrelic.recordMetric('Custom/driver/location_updates_per_sec', count);
  }

  recordDriverOnlineCount(regionId: string, count: number) {
    newrelic.recordMetric(`Custom/driver/${regionId}/online_count`, count);
  }

  recordKafkaConsumerLag(topic: string, lag: number) {
    newrelic.recordMetric(`Custom/kafka/${topic}/consumer_lag`, lag);
  }

  recordRedisLatency(operation: string, ms: number) {
    newrelic.recordMetric(`Custom/redis/${operation}_ms`, ms);
  }

  noticeError(err: Error, context?: Record<string, string>) {
    newrelic.noticeError(err, context);
  }
}
```

### Metrics Constants

```typescript
export const METRIC_NAMES = {
  RIDE_REQUEST_LATENCY:     'Custom/ride/request_latency_ms',
  MATCHING_DURATION:        'Custom/matching/duration_ms',
  DRIVER_ONLINE_COUNT:      'Custom/driver/{regionId}/online_count',
  KAFKA_CONSUMER_LAG:       'Custom/kafka/{topic}/consumer_lag',
  REDIS_GEO_QUERY:          'Custom/redis/geo_query_ms',
  PAYMENT_PROCESSING_TIME:  'Custom/payment/processing_time_ms',
} as const;
```

### Health Check Endpoint

```typescript
@Controller('health')
export class HealthController {
  @Get()
  async check(): Promise<HealthStatus> {
    const [postgres, redis, kafka] = await Promise.allSettled([
      this.checkPostgres(),
      this.checkRedis(),
      this.checkKafka(),
    ]);

    const status = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services: {
        postgres: postgres.status === 'fulfilled' ? 'up' : 'down',
        redis: redis.status === 'fulfilled' ? 'up' : 'down',
        kafka: kafka.status === 'fulfilled' ? 'up' : 'down',
      },
    };

    const allUp = Object.values(status.services).every(s => s === 'up');
    if (!allUp) {
      // Return 503 if any critical service is down
      throw new ServiceUnavailableException(status);
    }

    return status;
  }

  private async checkPostgres(): Promise<void> {
    await this.dataSource.query('SELECT 1');
  }

  private async checkRedis(): Promise<void> {
    const result = await this.redis.ping();
    if (result !== 'PONG') throw new Error('Redis PING failed');
  }

  private async checkKafka(): Promise<void> {
    await this.kafkaAdmin.listTopics();
  }
}
```

### All-Exceptions Filter

```typescript
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const correlationId = (request as any).correlationId;

    if (status >= 500) {
      this.logger.error(`Unhandled exception`, {
        correlationId,
        status,
        path: request.url,
        error: exception instanceof Error ? exception.message : 'Unknown',
        stack: exception instanceof Error ? exception.stack : undefined,
      });
      this.newRelicService.noticeError(exception as Error, { correlationId });
    }

    response.status(status).send({
      statusCode: status,
      correlationId,
      message: status >= 500 ? 'Internal server error' : (exception as HttpException).message,
      timestamp: new Date().toISOString(),
    });
  }
}
```

### Slow Query Logging (TypeORM)

```typescript
// In TypeORM data source config:
{
  logging: process.env.NODE_ENV === 'development' ? 'all' : ['error', 'warn'],
  logger: 'advanced-console',
  maxQueryExecutionTime: 500,  // log queries > 500ms as warnings
}
```

### New Relic Alert Policies (document these, configure via NR console)

```
Alert: Kafka Consumer Lag
  Condition: Custom/kafka/*/consumer_lag > 1000 for 2 minutes
  Action: PagerDuty + Slack

Alert: Matching Duration P95
  Condition: Custom/matching/duration_ms P95 > 3000
  Action: Slack

Alert: API Error Rate
  Condition: error rate > 1% for 5 minutes
  Action: PagerDuty

Alert: Redis Memory
  Condition: redis.memUsageBytes > 80% of maxMemory
  Action: Slack

Alert: Driver Online Count Drop
  Condition: Custom/driver/*/online_count drops 30%+ in 5 minutes
  Action: Slack (possible Redis failure)
```

### Unit Tests

```typescript
describe('CorrelationIdMiddleware', () => {
  it('generates correlationId if not present in headers')
  it('uses existing correlationId from X-Correlation-ID header')
  it('adds correlationId to response headers')
})

describe('AllExceptionsFilter', () => {
  it('returns 500 with sanitized message on unhandled error')
  it('returns 400 on BadRequestException')
  it('includes correlationId in error response')
  it('does not expose stack trace in response body')
})
```

## Update Progress

Check off all Observability items in PROJECT_PROGRESS.md.
Mark Phase 5 complete when all three Phase 5 modules are done.
Update Overall Completion to 100%.
