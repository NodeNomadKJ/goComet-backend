import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';

const HEARTBEAT_KEY = 'drivers:heartbeat';
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class StaleDriverCleanupService {
  private readonly logger = new Logger(StaleDriverCleanupService.name);

  constructor(@InjectRedis() private readonly redis: Redis) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async cleanupStaleDrivers(): Promise<void> {
    const cutoff = Date.now() - STALE_THRESHOLD_MS;

    // Find all heartbeat entries older than 5 minutes
    const staleMembers = await this.redis.zrangebyscore(HEARTBEAT_KEY, 0, cutoff);

    if (staleMembers.length === 0) return;

    this.logger.warn({ count: staleMembers.length }, 'Evicting stale drivers from GEO index');

    // Each member is "{regionId}:{driverId}" — split on first colon only
    const pipeline = this.redis.pipeline();

    for (const member of staleMembers) {
      const sep = member.indexOf(':');
      const regionId = member.substring(0, sep);
      const driverId = member.substring(sep + 1);

      pipeline.zrem(`drivers:geo:${regionId}`, driverId);
      pipeline.del(`driver:status:${driverId}`);
    }

    // Remove evicted entries from heartbeat set atomically
    pipeline.zremrangebyscore(HEARTBEAT_KEY, 0, cutoff);

    await pipeline.exec();

    this.logger.warn({ count: staleMembers.length }, 'Stale drivers removed');
  }
}
