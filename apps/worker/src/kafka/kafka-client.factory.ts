import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka } from 'kafkajs';

@Injectable()
export class KafkaClientFactory {
  private readonly client: Kafka;

  constructor(private readonly config: ConfigService) {
    this.client = new Kafka({
      clientId: 'gocomet-worker',
      brokers: [this.config.get<string>('KAFKA_BROKERS', 'localhost:19092')],
      retry: { initialRetryTime: 100, retries: 8, multiplier: 2 },
    });
  }

  get(): Kafka {
    return this.client;
  }
}
