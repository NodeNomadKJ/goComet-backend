import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';

const SURGE_KEY = (regionId: string, zone = 'default') => `surge:${regionId}:${zone}`;
const SURGE_TTL = 60;
const MAX_SURGE = 3.0;

@Injectable()
export class SurgeService {
  private readonly logger = new Logger(SurgeService.name);

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async getSurgeMultiplier(regionId: string, zone = 'default'): Promise<number> {
    const raw = await this.redis.get(SURGE_KEY(regionId, zone));
    return raw ? Math.min(parseFloat(raw), MAX_SURGE) : 1.0;
  }

  async calculateAndStoreSurge(regionId: string): Promise<void> {
    const driverCount = await this.redis.zcard(`drivers:heartbeat`);

    let multiplier = 1.0;
    if (driverCount === 0) multiplier = 2.5;
    else if (driverCount < 5) multiplier = 1.8;
    else if (driverCount < 10) multiplier = 1.3;
    else multiplier = 1.0;

    multiplier = Math.min(multiplier, MAX_SURGE);

    await this.redis.set(SURGE_KEY(regionId), String(multiplier), 'EX', SURGE_TTL);
    this.logger.debug({ regionId, multiplier }, 'Surge updated');
  }
}
