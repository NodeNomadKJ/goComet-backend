import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import { KAFKA_TOPICS } from '@gocomet/common';
import { KafkaProducerService } from '../../kafka/kafka-producer.service';
import { DriverService } from '../driver.service';
import type { LocationUpdateDto } from '../dto/location-update.dto';

// Redis key helpers — mirrored from driver.service.ts for consistency
const GEO_KEY = (regionId: string) => `drivers:geo:${regionId}`;
const STATUS_KEY = (driverId: string) => `driver:status:${driverId}`;

// Sorted set tracking last-seen timestamp for every online driver (per region member = "{regionId}:{driverId}")
const HEARTBEAT_KEY = 'drivers:heartbeat';

// Cache mapping userId:tenantId → driver entity UUID (avoids DB hit on location hot path)
const ENTITY_CACHE_KEY = (userId: string, tenantId: string) => `driver:entity:${userId}:${tenantId}`;
const ENTITY_CACHE_TTL = 3600; // 1 hour

// Rate limiting
const RATE_KEY = (driverId: string) => `driver:location:rate:${driverId}`;
const MAX_UPDATES_PER_SEC = 2;
const STATUS_TTL = 30 * 60; // 30 minutes — stale cleanup sentinel

@Injectable()
export class LocationService {
  private readonly logger = new Logger(LocationService.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    private readonly driverService: DriverService,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  async updateLocation(
    userId: string,
    tenantId: string,
    regionId: string,
    dto: LocationUpdateDto,
  ): Promise<void> {
    const driverId = await this.resolveDriverEntityId(userId, tenantId);

    await this.enforceRateLimit(driverId);

    const now = Date.now();

    // Single pipeline for all Redis writes — Rule 1: no PostgreSQL in this path
    const pipeline = this.redis.pipeline();

    // (1) Geospatial index — lng before lat is the Redis GEO convention
    pipeline.geoadd(GEO_KEY(regionId), dto.lng, dto.lat, driverId);

    // (2) Status hash carries last position + freshness for the matching engine
    pipeline.hset(STATUS_KEY(driverId), {
      lastLat: String(dto.lat),
      lastLng: String(dto.lng),
      heading: String(dto.heading ?? ''),
      lastSeen: String(now),
    });
    pipeline.expire(STATUS_KEY(driverId), STATUS_TTL);

    // (3) Heartbeat sorted set — score = lastSeen ms; cron uses ZRANGEBYSCORE to evict stale
    pipeline.zadd(HEARTBEAT_KEY, now, `${regionId}:${driverId}`);

    await pipeline.exec();

    await this.kafkaProducer.emit(
      KAFKA_TOPICS.DRIVER_LOCATION_UPDATED,
      { driverId, userId, lat: dto.lat, lng: dto.lng, heading: dto.heading, regionId, tenantId, timestamp: Date.now() },
      tenantId,
      regionId,
    );

    // WebSocket emit (driver:location → active ride room) wired in Phase 3
    // when driver:active-ride:{driverId} key is populated by matching engine
  }

  // Resolves userId + tenantId → driver entity UUID via Redis cache (DB fallback on cold start)
  async resolveDriverEntityId(userId: string, tenantId: string): Promise<string> {
    const cached = await this.redis.get(ENTITY_CACHE_KEY(userId, tenantId));
    if (cached) return cached;

    // Cold start: first location update before any setAvailability cache population
    this.logger.warn(
      { userId, tenantId },
      'Driver entity ID cache miss — fetching from DB (will be cached for next call)',
    );
    const driver = await this.driverService.getProfile(userId, tenantId);
    await this.redis.set(ENTITY_CACHE_KEY(userId, tenantId), driver.id, 'EX', ENTITY_CACHE_TTL);
    return driver.id;
  }

  // Sliding-window rate limiter: max 2 updates per driver per second
  private async enforceRateLimit(driverId: string): Promise<void> {
    const key = RATE_KEY(driverId);
    const now = Date.now();
    const windowMs = 1000;
    const member = `${now}-${Math.random().toString(36).slice(2)}`;

    const pipeline = this.redis.pipeline();
    pipeline.zremrangebyscore(key, 0, now - windowMs); // evict entries outside window
    pipeline.zadd(key, now, member);
    pipeline.zcard(key);
    pipeline.expire(key, 2); // 2× window TTL

    const results = await pipeline.exec();
    const count = (results?.[2]?.[1] as number) ?? 0;

    if (count > MAX_UPDATES_PER_SEC) {
      throw new HttpException(
        `Location update rate limit exceeded — max ${MAX_UPDATES_PER_SEC}/s per driver`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
