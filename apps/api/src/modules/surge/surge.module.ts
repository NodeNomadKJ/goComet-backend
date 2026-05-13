import { Module } from '@nestjs/common';
import { SurgeService } from './surge.service';
import { SurgePricingCron } from './cron/surge-pricing.cron';
import { SurgeController } from './surge.controller';

@Module({
  providers: [SurgeService, SurgePricingCron],
  controllers: [SurgeController],
  exports: [SurgeService],
})
export class SurgeModule {}
