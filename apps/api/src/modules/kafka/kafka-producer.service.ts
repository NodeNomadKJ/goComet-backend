import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Producer, CompressionTypes } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';
import type { DomainEvent, KafkaTopic } from '@gocomet/common';

@Injectable()
export class KafkaProducerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaProducerService.name);
  private producer!: Producer;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const kafka = new Kafka({
      clientId: 'gocomet-api',
      brokers: [this.config.get<string>('KAFKA_BROKERS', 'localhost:19092')],
      retry: { initialRetryTime: 100, retries: 8, multiplier: 2 },
    });
    this.producer = kafka.producer({ allowAutoTopicCreation: true });
    await this.producer.connect();
    this.logger.log('Kafka producer connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
  }

  async emit<T>(
    topic: KafkaTopic,
    payload: T,
    tenantId: string,
    regionId: string,
    partitionKey?: string,
    correlationId = uuidv4(),
  ): Promise<void> {
    const event: DomainEvent<T> = {
      eventId: uuidv4(),
      eventType: topic,
      tenantId,
      regionId,
      correlationId,
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
      payload,
    };

    await this.producer.send({
      topic,
      compression: CompressionTypes.GZIP,
      messages: [
        {
          key: partitionKey ?? tenantId,
          value: JSON.stringify(event),
        },
      ],
    });

    this.logger.debug({ topic, eventId: event.eventId, tenantId, regionId }, 'Kafka event emitted');
  }
}
