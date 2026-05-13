import { Injectable } from '@nestjs/common';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';

@Injectable()
export class ProcessedEventsService {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async isProcessed(eventId: string): Promise<boolean> {
    const key = `processed:event:${eventId}`;
    const result = await this.redis.set(key, '1', 'EX', 86400, 'NX');
    return result === null;
  }
}
