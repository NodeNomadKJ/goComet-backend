import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RideEntity } from './entities/ride.entity';
import { RideService } from './ride.service';
import { RideController } from './ride.controller';
import { TripModule } from '../trips/trip.module';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [TypeOrmModule.forFeature([RideEntity]), TripModule, RealtimeModule],
  providers: [RideService],
  controllers: [RideController],
  exports: [RideService],
})
export class RideModule {}
