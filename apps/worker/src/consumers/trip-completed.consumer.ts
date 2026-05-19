import { Injectable, Logger } from '@nestjs/common';
import { KAFKA_TOPICS } from '@gocomet/common';
import type { DomainEvent } from '@gocomet/common';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import { DriverStatus } from '@gocomet/common';
import { KafkaConsumerBase } from '../kafka/kafka-consumer.base';
import { KafkaClientFactory } from '../kafka/kafka-client.factory';
import { ProcessedEventsService } from '../kafka/processed-events.service';

interface TripCompletedPayload {
  tripId: string;
  rideId: string;
  riderId: string;
  driverId: string;
  finalFare: number;
  distanceKm: number;
  durationSecs: number;
}

@Injectable()
export class TripCompletedConsumer extends KafkaConsumerBase {
  protected readonly logger = new Logger(TripCompletedConsumer.name);
  protected readonly topic = KAFKA_TOPICS.TRIP_COMPLETED;
  protected readonly groupId = 'worker-trip.completed-consumer';

  constructor(
    kafkaFactory: KafkaClientFactory,
    processedEvents: ProcessedEventsService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    super(kafkaFactory, processedEvents);
  }

  protected async handle(event: DomainEvent): Promise<void> {
    const { driverId } = event.payload as TripCompletedPayload;

    await Promise.all([
      this.redis.hset(`driver:status:${driverId}`, 'status', DriverStatus.AVAILABLE),
      this.redis.del(`driver:active-ride:${driverId}`),
    ]);

    this.logger.log({ driverId, tripId: (event.payload as TripCompletedPayload).tripId }, 'Driver reset to AVAILABLE after trip completion');
  }
}
