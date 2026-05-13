import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserModule } from '../users/user.module';
import { DriverEntity } from './entities/driver.entity';
import { VehicleEntity } from './entities/vehicle.entity';
import { DriverService } from './driver.service';
import { DriverController } from './driver.controller';
import { LocationService } from './services/location.service';
import { StaleDriverCleanupService } from './cron/stale-driver.cron';

@Module({
  imports: [
    TypeOrmModule.forFeature([DriverEntity, VehicleEntity]),
    UserModule,
  ],
  providers: [DriverService, LocationService, StaleDriverCleanupService],
  controllers: [DriverController],
  exports: [DriverService, LocationService],
})
export class DriverModule {}
