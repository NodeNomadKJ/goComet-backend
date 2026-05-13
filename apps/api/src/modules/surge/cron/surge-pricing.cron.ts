import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import { SurgeService } from '../surge.service';

@Injectable()
export class SurgePricingCron {
  private readonly logger = new Logger(SurgePricingCron.name);

  constructor(
    private readonly surgeService: SurgeService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async updateSurgePricing(): Promise<void> {
    const keys = await this.redis.keys('drivers:geo:*');
    if (keys.length === 0) return;

    const regionIds = keys.map((k) => k.replace('drivers:geo:', ''));
    await Promise.all(regionIds.map((rid) => this.surgeService.calculateAndStoreSurge(rid)));

    this.logger.debug({ regionCount: regionIds.length }, 'Surge pricing updated');
  }
}
