import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from '../users/user.module';
import { RideModule } from '../rides/ride.module';
import { RiderEntity } from './entities/rider.entity';
import { RiderPaymentMethodEntity } from './entities/rider-payment-method.entity';
import { RiderService } from './rider.service';
import { RiderController } from './rider.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([RiderEntity, RiderPaymentMethodEntity]),
    UserModule,
    RideModule,
  ],
  providers: [RiderService],
  controllers: [RiderController],
  exports: [RiderService],
})
export class RiderModule {}
