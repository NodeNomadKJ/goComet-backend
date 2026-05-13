import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import { Kafka, Consumer } from 'kafkajs';
import { KAFKA_TOPICS } from '@gocomet/common';
import type { DomainEvent } from '@gocomet/common';
import { MatchingService } from '../matching.service';

interface RideCreatedPayload {
  rideId: string;
  riderId: string;
  regionId: string;
  vehicleType: string;
  pickupLat: number;
  pickupLng: number;
  pickupAddress: string;
  dropLat: number;
  dropLng: number;
  dropAddress: string;
  fareEstimate: number;
  surgeMultiplier: number;
}

@Injectable()
export class MatchingConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatchingConsumer.name);
  private consumer!: Consumer;

  constructor(
    private readonly config: ConfigService,
    private readonly matchingService: MatchingService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    const kafka = new Kafka({
      clientId: 'gocomet-api-matching',
      brokers: [this.config.get<string>('KAFKA_BROKERS', 'localhost:19092')],
      retry: { initialRetryTime: 100, retries: 8, multiplier: 2 },
    });
    this.consumer = kafka.consumer({ groupId: 'api-ride.request.created-consumer' });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: KAFKA_TOPICS.RIDE_REQUEST_CREATED, fromBeginning: false });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const raw = message.value?.toString();
        if (!raw) return;
        try {
          const event = JSON.parse(raw) as DomainEvent<RideCreatedPayload>;
          const dedupKey = `processed:event:${event.eventId}`;
          const already = await this.redis.set(dedupKey, '1', 'EX', 86400, 'NX');
          if (already === null) {
            this.logger.debug({ eventId: event.eventId }, 'Duplicate matching event skipped');
            return;
          }
          const p = event.payload;
          await this.matchingService.startMatching(
            p.rideId, event.tenantId, p.regionId,
            p.riderId, p.pickupLng, p.pickupLat,
            p.vehicleType, p.fareEstimate,
            p.pickupAddress ?? '', p.dropAddress ?? '',
            event.correlationId,
          );
        } catch (err) {
          this.logger.error({ err: (err as Error).message }, 'Matching consumer error');
        }
      },
    });
    this.logger.log('Matching consumer started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
  }
}
