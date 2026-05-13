import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';

export interface HealthStatus {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptime: number;
  services: {
    postgres: 'up' | 'down';
    redis: 'up' | 'down';
  };
}

@Injectable()
export class HealthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthStatus> {
    const [postgres, redis] = await Promise.allSettled([
      this.checkPostgres(),
      this.checkRedis(),
    ]);

    const services = {
      postgres: postgres.status === 'fulfilled' ? ('up' as const) : ('down' as const),
      redis: redis.status === 'fulfilled' ? ('up' as const) : ('down' as const),
    };

    return {
      status: Object.values(services).every((s) => s === 'up') ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services,
    };
  }

  private async checkPostgres(): Promise<void> {
    await this.dataSource.query('SELECT 1');
  }

  private async checkRedis(): Promise<void> {
    const pong = await this.redis.ping();
    if (pong !== 'PONG') throw new Error('Redis PING failed');
  }
}
