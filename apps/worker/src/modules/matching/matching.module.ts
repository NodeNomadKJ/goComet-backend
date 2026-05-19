import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MatchingService } from './matching.service';
import { TripEntity } from '@gocomet/database';
import { KafkaModule } from '../../kafka/kafka.module';

@Module({
  imports: [TypeOrmModule.forFeature([TripEntity]), KafkaModule],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
