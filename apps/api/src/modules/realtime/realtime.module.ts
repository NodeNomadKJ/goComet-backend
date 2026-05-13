import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DriverModule } from '../drivers/driver.module';
import { RiderGateway } from './gateways/rider.gateway';
import { DriverGateway } from './gateways/driver.gateway';
import { RealtimeService } from './realtime.service';

@Module({
  imports: [
    AuthModule,    // provides JwtService + ConfigService for WS auth
    DriverModule,  // provides DriverService for auto-offline on disconnect
  ],
  providers: [RiderGateway, DriverGateway, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
