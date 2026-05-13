import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Consumer } from 'kafkajs';
import { KAFKA_TOPICS } from '@gocomet/common';

const DLQ_TOPICS = Object.values(KAFKA_TOPICS).map((t) => `${t}.dlq`);

@Injectable()
export class DlqConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DlqConsumer.name);
  private consumer!: Consumer;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const kafka = new Kafka({
      clientId: 'gocomet-worker-dlq',
      brokers: [this.config.get<string>('KAFKA_BROKERS', 'localhost:19092')],
      retry: { initialRetryTime: 100, retries: 8, multiplier: 2 },
    });

    this.consumer = kafka.consumer({ groupId: 'worker-dlq-consumer' });
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: DLQ_TOPICS, fromBeginning: false });

    await this.consumer.run({
      eachMessage: async ({ topic, message }) => {
        const raw = message.value?.toString() ?? '';
        const reason = message.headers?.['x-dlq-reason']?.toString() ?? 'unknown';
        const sourceTopic = message.headers?.['x-dlq-source-topic']?.toString() ?? topic;
        const timestamp = message.headers?.['x-dlq-timestamp']?.toString() ?? '';

        let eventId = 'unknown';
        try {
          const parsed = JSON.parse(raw) as { eventId?: string };
          eventId = parsed.eventId ?? 'unknown';
        } catch {
          // raw non-JSON message — keep eventId as 'unknown'
        }

        this.logger.error(
          { dlqTopic: topic, sourceTopic, eventId, reason, timestamp },
          'DLQ message — manual intervention required',
        );
      },
    });

    this.logger.log(`DLQ consumer started — watching ${DLQ_TOPICS.length} DLQ topics`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
  }
}
