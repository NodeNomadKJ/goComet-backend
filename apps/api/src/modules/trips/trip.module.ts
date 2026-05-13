import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TripEntity } from './entities/trip.entity';
import { TripEventEntity } from './entities/trip-event.entity';
import { RideEntity } from '../rides/entities/ride.entity';
import { PaymentEntity } from '../payments/entities/payment.entity';
import { TripService } from './trip.service';
import { TripController } from './trip.controller';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TripEntity, TripEventEntity, RideEntity, PaymentEntity]),
    RealtimeModule,
  ],
  providers: [TripService],
  controllers: [TripController],
  exports: [TripService],
})
export class TripModule {}
