import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Consumer } from 'kafkajs';
import { KAFKA_TOPICS } from '@gocomet/common';
import type { DomainEvent } from '@gocomet/common';
import { KafkaClientFactory } from '../kafka/kafka-client.factory';
import { ProcessedEventsService } from '../kafka/processed-events.service';
import { MatchingService } from '../modules/matching/matching.service';

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
    private readonly kafkaFactory: KafkaClientFactory,
    private readonly processedEvents: ProcessedEventsService,
    private readonly matchingService: MatchingService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.consumer = this.kafkaFactory.get().consumer({ groupId: 'worker-ride.request.created-consumer' });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: KAFKA_TOPICS.RIDE_REQUEST_CREATED, fromBeginning: false });

    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const raw = message.value?.toString();
        if (!raw) return;
        try {
          const event = JSON.parse(raw) as DomainEvent<RideCreatedPayload>;
          if (await this.processedEvents.isProcessed(event.eventId)) {
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
