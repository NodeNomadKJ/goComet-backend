# /implement-kafka-events

Implement the Kafka infrastructure: typed producer, idempotent consumers, DLQ, topic registry.
Prerequisite: Phase 2 complete, worker app bootstrapped.

## What to Build

### File Structure

```
packages/kafka/
  src/
    kafka.module.ts
    kafka-producer.service.ts
    kafka-consumer.base.ts         ← abstract base all consumers extend
    processed-events.service.ts    ← Redis-based dedup
    interfaces/
      domain-event.interface.ts
      consumer-options.interface.ts
    constants/
      kafka-topics.constants.ts

apps/worker/src/
  main.ts
  app.module.ts
  consumers/
    driver-location.consumer.ts
    matching.consumer.ts
    driver-snapshot.consumer.ts
    payment.consumer.ts
    notification.consumer.ts
  dlq/
    dlq.consumer.ts                ← processes dead letter queue
```

### Topic Registry (single source of truth)

```typescript
// packages/kafka/src/constants/kafka-topics.constants.ts
export const KAFKA_TOPICS = {
  // Ride domain
  RIDE_REQUEST_CREATED:     'ride.request.created',
  RIDE_MATCHING_STARTED:    'ride.matching.started',
  RIDE_MATCHING_FAILED:     'ride.matching.failed',
  RIDE_REQUEST_CANCELLED:   'ride.request.cancelled',

  // Driver domain
  DRIVER_AVAILABILITY_CHANGED: 'driver.availability.changed',
  DRIVER_ASSIGNMENT_CREATED:   'driver.assignment.created',
  DRIVER_LOCATION_UPDATED:     'driver.location.updated',

  // Trip domain
  TRIP_STATUS_CHANGED:   'trip.status.changed',
  TRIP_COMPLETED:        'trip.completed',

  // Payment domain
  PAYMENT_CHARGE_REQUESTED:  'payment.charge.requested',
  PAYMENT_CHARGE_COMPLETED:  'payment.charge.completed',
  PAYMENT_CHARGE_FAILED:     'payment.charge.failed',
  PAYMENT_REFUND_REQUESTED:  'payment.refund.requested',

  // Notification domain
  NOTIFICATION_PUSH_REQUESTED: 'notification.push.requested',
  NOTIFICATION_SMS_REQUESTED:  'notification.sms.requested',
  NOTIFICATION_EMAIL_REQUESTED: 'notification.email.requested',
} as const;

export type KafkaTopic = typeof KAFKA_TOPICS[keyof typeof KAFKA_TOPICS];

// Dead letter queue: DLQ topics = original topic + '.dlq'
export const toDlqTopic = (topic: KafkaTopic) => `${topic}.dlq` as const;
```

### DomainEvent Interface

```typescript
// packages/kafka/src/interfaces/domain-event.interface.ts
export interface DomainEvent<T = unknown> {
  eventId: string;        // uuidv4, used for consumer idempotency check
  eventType: KafkaTopic;
  tenantId: string;
  regionId: string;
  correlationId: string;  // request trace ID, flows across services
  timestamp: string;      // ISO 8601
  schemaVersion: number;  // increment on breaking changes
  payload: T;
}
```

### KafkaProducerService

```typescript
@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private producer: Producer;

  async onModuleInit() {
    this.producer = this.kafka.producer({
      compression: CompressionTypes.GZIP,
      idempotent: true,           // exactly-once semantics on producer side
      maxInFlightRequests: 5,
      transactionTimeout: 30000,
    });
    await this.producer.connect();
  }

  async emit<T>(
    topic: KafkaTopic,
    payload: T,
    context?: { tenantId: string; regionId: string; correlationId?: string },
  ): Promise<void> {
    const event: DomainEvent<T> = {
      eventId: uuidv4(),
      eventType: topic,
      tenantId: context?.tenantId ?? '',
      regionId: context?.regionId ?? '',
      correlationId: context?.correlationId ?? uuidv4(),
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
      payload,
    };

    await this.producer.send({
      topic,
      messages: [{
        key: context?.tenantId,  // partition by tenant for ordering
        value: JSON.stringify(event),
        headers: {
          'event-type': topic,
          'correlation-id': event.correlationId,
        },
      }],
    });
  }

  async onModuleDestroy() {
    await this.producer.disconnect();
  }
}
```

### ProcessedEventsService — Consumer Idempotency

```typescript
@Injectable()
export class ProcessedEventsService {
  private readonly TTL = 24 * 60 * 60; // 24 hours

  async isProcessed(eventId: string, consumerGroup: string): Promise<boolean> {
    const key = `processed:${consumerGroup}:${eventId}`;
    return (await this.redis.exists(key)) === 1;
  }

  async markProcessed(eventId: string, consumerGroup: string): Promise<void> {
    const key = `processed:${consumerGroup}:${eventId}`;
    await this.redis.set(key, '1', 'EX', this.TTL);
  }
}
```

### Abstract BaseConsumer

Every consumer extends this. It handles: deserialization, idempotency check, retry, DLQ.

```typescript
@Injectable()
export abstract class BaseConsumer<T = unknown> implements OnModuleInit {
  protected abstract readonly topic: KafkaTopic;
  protected abstract readonly consumerGroup: string;
  protected abstract handle(event: DomainEvent<T>): Promise<void>;

  private readonly MAX_RETRIES = 3;

  async onModuleInit() {
    const consumer = this.kafka.consumer({ groupId: this.consumerGroup });
    await consumer.connect();
    await consumer.subscribe({ topic: this.topic, fromBeginning: false });

    await consumer.run({
      eachMessage: async ({ message }) => {
        const event = JSON.parse(message.value!.toString()) as DomainEvent<T>;
        await this.processWithIdempotency(event);
      },
    });
  }

  private async processWithIdempotency(event: DomainEvent<T>): Promise<void> {
    // Skip if already processed
    if (await this.processedEventsService.isProcessed(event.eventId, this.consumerGroup)) {
      this.logger.debug({ eventId: event.eventId }, 'Skipping duplicate event');
      return;
    }

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        await this.handle(event);
        await this.processedEventsService.markProcessed(event.eventId, this.consumerGroup);
        return;
      } catch (err) {
        lastError = err as Error;
        const delay = Math.pow(2, attempt) * 200; // 200ms, 400ms, 800ms
        this.logger.warn({ eventId: event.eventId, attempt, delay }, 'Consumer retry');
        await new Promise(r => setTimeout(r, delay));
      }
    }

    // All retries exhausted → send to DLQ
    await this.kafkaProducer.emit(toDlqTopic(this.topic), {
      originalEvent: event,
      error: lastError?.message,
      failedAt: new Date().toISOString(),
      consumerGroup: this.consumerGroup,
    }, { tenantId: event.tenantId, regionId: event.regionId });

    this.logger.error({ eventId: event.eventId, topic: this.topic }, 'Event sent to DLQ');
  }
}
```

### Example Consumer Implementation

```typescript
// apps/worker/src/consumers/matching.consumer.ts
@Injectable()
export class MatchingConsumer extends BaseConsumer<RideRequestCreatedPayload> {
  protected readonly topic = KAFKA_TOPICS.RIDE_REQUEST_CREATED;
  protected readonly consumerGroup = 'gocomet-matching-consumer';

  protected async handle(event: DomainEvent<RideRequestCreatedPayload>): Promise<void> {
    const { rideId, riderId, pickupLat, pickupLng, vehicleType, tenantId, regionId } = event.payload;
    await this.matchingService.matchRide(rideId, {
      rideId, riderId, pickupLat, pickupLng, vehicleType,
      tenantId, regionId, fareEstimate: event.payload.fareEstimate,
      correlationId: event.correlationId,
    });
  }
}
```

### DLQ Consumer

```typescript
// Manual review + retry mechanism for DLQ events
@Injectable()
export class DlqConsumer implements OnModuleInit {
  async onModuleInit() {
    // Subscribe to all DLQ topics
    const dlqTopics = Object.values(KAFKA_TOPICS).map(toDlqTopic);
    // ... alert + store in DB for manual investigation
  }
}
```

### Docker Compose Kafka Config

Ensure Redpanda has these topics pre-created (or use auto-create):
```yaml
# docker/redpanda/init-topics.sh
for topic in ride.request.created driver.location.updated trip.completed ...; do
  rpk topic create $topic --partitions 12 --replicas 1
done
```

Partition count = 12 per topic (allows 12x parallelism per consumer group).

### Kafka Module Config

```typescript
KafkaModule.forRoot({
  client: {
    clientId: process.env.KAFKA_CLIENT_ID,
    brokers: process.env.KAFKA_BROKERS.split(','),
    retry: {
      initialRetryTime: 100,
      retries: 8,
    },
    logLevel: logLevel.WARN,
  },
})
```

### Unit Tests

```typescript
describe('KafkaProducerService', () => {
  it('wraps payload in DomainEvent envelope')
  it('uses tenantId as partition key')
  it('includes correlationId in headers')
})

describe('ProcessedEventsService', () => {
  it('returns false for unseen eventId')
  it('returns true after marking processed')
  it('uses separate keys per consumerGroup')
})

describe('BaseConsumer', () => {
  it('skips processing if eventId already processed')
  it('retries up to MAX_RETRIES on failure')
  it('sends to DLQ after all retries exhausted')
  it('marks as processed only on success')
})
```

## Update Progress

Check off all Kafka Events items in PROJECT_PROGRESS.md.
Verify all topic names are registered in KAFKA_TOPICS constants.
