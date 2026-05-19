import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Producer } from 'kafkajs';
import { v4 as uuidv4 } from 'uuid';
import { KAFKA_TOPICS } from '@gocomet/common';
import type { DomainEvent } from '@gocomet/common';
import { KafkaConsumerBase } from '../kafka/kafka-consumer.base';
import { KafkaClientFactory } from '../kafka/kafka-client.factory';
import { ProcessedEventsService } from '../kafka/processed-events.service';

interface PaymentChargePayload {
  paymentId: string;
  tripId: string;
  riderId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
}

@Injectable()
export class PaymentConsumer extends KafkaConsumerBase implements OnModuleInit, OnModuleDestroy {
  protected readonly logger = new Logger(PaymentConsumer.name);
  protected readonly topic = KAFKA_TOPICS.PAYMENT_CHARGE_REQUESTED;
  protected readonly groupId = 'worker-payment.charge.requested-consumer';

  private producer!: Producer;

  constructor(kafkaFactory: KafkaClientFactory, processedEvents: ProcessedEventsService) {
    super(kafkaFactory, processedEvents);
  }

  async onModuleInit(): Promise<void> {
    this.producer = this.kafkaFactory.get().producer({ allowAutoTopicCreation: true });
    await this.producer.connect();
    await super.onModuleInit();
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.disconnect();
    await super.onModuleDestroy();
  }

  protected async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as PaymentChargePayload;
    await new Promise((r) => setTimeout(r, 200));

    const success = Math.random() > 0.1;
    const pspReference = `mock-psp-${uuidv4()}`;

    const resultPayload = success
      ? { paymentId: p.paymentId, pspReference, status: 'success' as const }
      : { paymentId: p.paymentId, failureReason: 'Mock PSP declined', status: 'failure' as const };

    const resultEvent: DomainEvent = {
      eventId: uuidv4(),
      eventType: success ? KAFKA_TOPICS.PAYMENT_CHARGE_COMPLETED : KAFKA_TOPICS.PAYMENT_CHARGE_FAILED,
      tenantId: event.tenantId,
      regionId: event.regionId,
      correlationId: event.correlationId,
      timestamp: new Date().toISOString(),
      schemaVersion: 1,
      payload: resultPayload,
    };

    await this.producer.send({
      topic: resultEvent.eventType,
      messages: [{ key: event.tenantId, value: JSON.stringify(resultEvent) }],
    });

    this.logger.log({ paymentId: p.paymentId, success }, 'Payment processed');
  }
}
