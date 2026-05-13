import { Module } from '@nestjs/common';
import { ProcessedEventsService } from './processed-events.service';

@Module({
  providers: [ProcessedEventsService],
  exports: [ProcessedEventsService],
})
export class KafkaModule {}
