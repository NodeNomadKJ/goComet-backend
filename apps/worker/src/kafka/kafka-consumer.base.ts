import { OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kafka, Consumer, Producer, EachMessagePayload, CompressionTypes } from 'kafkajs';
import type { DomainEvent } from '@gocomet/common';
import { ProcessedEventsService } from './processed-events.service';

const MAX_RETRIES = 3;

export abstract class KafkaConsumerBase implements OnModuleInit, OnModuleDestroy {
  protected abstract readonly logger: Logger;
  protected abstract readonly topic: string | string[];
  protected abstract readonly groupId: string;

  protected consumer!: Consumer;
  private dlqProducer!: Producer;

  constructor(
    protected readonly config: ConfigService,
    protected readonly processedEvents: ProcessedEventsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const kafka = new Kafka({
      clientId: `gocomet-worker-${this.groupId}`,
      brokers: [this.config.get<string>('KAFKA_BROKERS', 'localhost:19092')],
      retry: { initialRetryTime: 100, retries: 8, multiplier: 2 },
    });

    this.dlqProducer = kafka.producer();
    await this.dlqProducer.connect();

    this.consumer = kafka.consumer({ groupId: this.groupId });
    await this.consumer.connect();

    const topicsArray = Array.isArray(this.topic) ? this.topic : [this.topic];
    await this.consumer.subscribe({ topics: topicsArray, fromBeginning: false });

    await this.consumer.run({
      eachMessage: async (payload: EachMessagePayload) => {
        const raw = payload.message.value?.toString();
        if (!raw) return;

        let event: DomainEvent;
        try {
          event = JSON.parse(raw) as DomainEvent;
        } catch {
          this.logger.error({ topic: payload.topic }, 'Failed to parse message — sending to DLQ');
          await this.sendToDlq(payload.topic, raw, 'JSON parse failure');
          return;
        }

        if (await this.processedEvents.isProcessed(event.eventId)) {
          this.logger.debug({ eventId: event.eventId }, 'Duplicate event skipped');
          return;
        }

        let lastError: Error | undefined;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            await this.handle(event);
            return;
          } catch (err) {
            lastError = err as Error;
            this.logger.warn(
              { eventId: event.eventId, attempt, err: lastError.message, topic: payload.topic },
              'Consumer handler failed — retrying',
            );
            if (attempt < MAX_RETRIES) {
              await new Promise((r) => setTimeout(r, 100 * Math.pow(2, attempt - 1)));
            }
          }
        }

        this.logger.error(
          { eventId: event.eventId, topic: payload.topic, err: lastError?.message },
          `All ${MAX_RETRIES} retries exhausted — sending to DLQ`,
        );
        await this.sendToDlq(payload.topic, raw, lastError?.message ?? 'Unknown error');
      },
    });
    this.logger.log(`Consumer started — topic: ${this.topic}, group: ${this.groupId}`);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.consumer.disconnect(), this.dlqProducer.disconnect()]);
  }

  private async sendToDlq(originalTopic: string, raw: string, reason: string): Promise<void> {
    const dlqTopic = `${originalTopic}.dlq`;
    try {
      await this.dlqProducer.send({
        topic: dlqTopic,
        compression: CompressionTypes.GZIP,
        messages: [
          {
            value: raw,
            headers: {
              'x-dlq-reason': reason,
              'x-dlq-source-topic': originalTopic,
              'x-dlq-timestamp': new Date().toISOString(),
            },
          },
        ],
      });
      this.logger.log({ dlqTopic, originalTopic }, 'Message sent to DLQ');
    } catch (dlqErr) {
      this.logger.error({ dlqTopic, err: (dlqErr as Error).message }, 'CRITICAL: Failed to send to DLQ');
    }
  }

  protected abstract handle(event: DomainEvent): Promise<void>;
}
