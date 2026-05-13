import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RideEntity } from '../rides/entities/ride.entity';
import { MatchingService } from './matching.service';
import { MatchingConsumer } from './consumers/matching.consumer';
import { RealtimeModule } from '../realtime/realtime.module';
import { TripModule } from '../trips/trip.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([RideEntity]),
    RealtimeModule,
    TripModule,
  ],
  providers: [MatchingService, MatchingConsumer],
})
export class MatchingModule {}
