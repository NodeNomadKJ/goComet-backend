import { Injectable, Logger } from '@nestjs/common';
import { KAFKA_TOPICS } from '@gocomet/common';
import type { DomainEvent } from '@gocomet/common';
import { KafkaConsumerBase } from '../kafka/kafka-consumer.base';
import { KafkaClientFactory } from '../kafka/kafka-client.factory';
import { ProcessedEventsService } from '../kafka/processed-events.service';

interface NotificationPayload {
  userId: string;
  type: string;
  title: string;
  body: string;
  channel?: string;
}

@Injectable()
export class NotificationConsumer extends KafkaConsumerBase {
  protected readonly logger = new Logger(NotificationConsumer.name);
  protected readonly topic = KAFKA_TOPICS.NOTIFICATION_PUSH_REQUESTED;
  protected readonly groupId = 'worker-notification-consumer';

  constructor(kafkaFactory: KafkaClientFactory, processedEvents: ProcessedEventsService) {
    super(kafkaFactory, processedEvents);
  }

  async onModuleInit(): Promise<void> {
    this.consumer = this.kafkaFactory.get().consumer({ groupId: this.groupId });
    await this.consumer.connect();
    await this.consumer.subscribe({
      topics: [
        KAFKA_TOPICS.NOTIFICATION_PUSH_REQUESTED,
        KAFKA_TOPICS.NOTIFICATION_SMS_REQUESTED,
        KAFKA_TOPICS.NOTIFICATION_EMAIL_REQUESTED,
      ],
      fromBeginning: false,
    });
    await this.consumer.run({
      eachMessage: async ({ message }) => {
        const raw = message.value?.toString();
        if (!raw) return;
        try {
          const event = JSON.parse(raw) as DomainEvent;
          if (await this.processedEvents.isProcessed(event.eventId)) return;
          await this.handle(event);
        } catch (err) {
          this.logger.error({ err: (err as Error).message }, 'Notification consumer error');
        }
      },
    });
    this.logger.log('Notification consumer started (push + sms + email)');
  }

  protected async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as NotificationPayload;
    this.logger.log(
      { userId: p.userId, type: p.type, eventType: event.eventType },
      `[MOCK] Notification sent: ${p.title}`,
    );
  }
}
