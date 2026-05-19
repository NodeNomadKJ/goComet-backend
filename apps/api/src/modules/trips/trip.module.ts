import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TripEntity, TripEventEntity } from '@gocomet/database';
import { RideEntity } from '../rides/entities/ride.entity';
import { PaymentEntity } from '../payments/entities/payment.entity';
import { TripService } from './trip.service';
import { TripController } from './trip.controller';
import { RealtimeModule } from '../realtime/realtime.module';
import { RedisModule } from '@gocomet/redis';

@Module({
  imports: [
    TypeOrmModule.forFeature([TripEntity, TripEventEntity, RideEntity, PaymentEntity]),
    RealtimeModule,
    RedisModule,
  ],
  providers: [TripService],
  controllers: [TripController],
  exports: [TripService],
})
export class TripModule {}
