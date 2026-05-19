import { Module } from '@nestjs/common';
import { ProcessedEventsService } from './processed-events.service';
import { KafkaClientFactory } from './kafka-client.factory';
import { KafkaProducerService } from './kafka-producer.service';

@Module({
  providers: [ProcessedEventsService, KafkaClientFactory, KafkaProducerService],
  exports: [ProcessedEventsService, KafkaClientFactory, KafkaProducerService],
})
export class KafkaModule {}
