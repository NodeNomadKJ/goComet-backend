# /implement-location-tracking

Implement high-throughput driver location pipeline. Target: 200k updates/sec.
Prerequisite: realtime gateway + Kafka infra in place.

## Architecture

```
Driver App → POST /drivers/location
               ↓ (< 5ms target)
           Redis GEO GEOADD (atomic, synchronous)
           Redis HSET driver:status (atomic, synchronous)
               ↓ (fire-and-forget, non-blocking)
           Kafka emit: driver.location.updated
               ↓ (async consumer, separate process)
           PostgreSQL last_location snapshot update
               ↓ (if driver has active ride)
           Redis pub/sub → Socket.IO → Rider client
```

## What to Build

### File Structure

```
apps/api/src/modules/location/
  location.module.ts
  location.controller.ts
  location.service.ts
  dto/
    update-location.dto.ts
    batch-location.dto.ts
  tests/
    location.service.spec.ts

apps/worker/src/consumers/
  driver-location.consumer.ts   ← updates PostgreSQL snapshot
  driver-stale.cron.ts          ← removes stale drivers from GEO set
```

### UpdateLocationDto

```typescript
export class UpdateLocationDto {
  @IsNumber() @Min(-90) @Max(90)
  lat: number;

  @IsNumber() @Min(-180) @Max(180)
  lng: number;

  @IsNumber() @Min(0) @Max(360)
  heading: number;  // degrees, 0 = north

  @IsNumber() @Min(0)
  speed: number;    // km/h

  @IsOptional() @IsNumber()
  accuracy?: number;  // GPS accuracy in meters

  @IsNumber()
  timestamp: number;  // epoch ms — client-side timestamp
}

// Batch variant for reducing HTTP overhead
export class BatchLocationUpdateDto {
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true })
  @Type(() => UpdateLocationDto)
  updates: UpdateLocationDto[];  // client sends last N updates in one call
}
```

### LocationService

```typescript
@Injectable()
export class LocationService {
  private readonly RATE_LIMIT_KEY = (driverId: string) => `loc:ratelimit:${driverId}`;
  private readonly MAX_UPDATES_PER_SEC = 2;

  async updateDriverLocation(
    driverId: string,
    regionId: string,
    tenantId: string,
    dto: UpdateLocationDto,
  ): Promise<void> {
    // 1. Rate limit check (Redis sliding window)
    await this.enforceRateLimit(driverId);

    // 2. Verify driver is online (must be in Redis status hash)
    const status = await this.redis.hget(`driver:status:${driverId}`, 'status');
    if (!status || status === 'OFFLINE') {
      throw new BadRequestException('Driver is not online');
    }

    // 3. Atomic Redis pipeline — this is the hot path, must be < 5ms
    const pipeline = this.redis.pipeline();
    pipeline.geoadd(`drivers:geo:${regionId}`, dto.lng, dto.lat, driverId);
    pipeline.hset(`driver:status:${driverId}`, {
      lastLat: dto.lat,
      lastLng: dto.lng,
      heading: dto.heading,
      speed: dto.speed,
      lastSeen: Date.now(),
    });
    await pipeline.exec();

    // 4. Check if driver has active ride — if so, broadcast location
    const activeRideId = await this.redis.get(`driver:active-ride:${driverId}`);
    if (activeRideId) {
      this.realtimeService.broadcastDriverLocation(activeRideId, dto.lat, dto.lng, dto.heading);
    }

    // 5. Fire-and-forget Kafka event (do NOT await)
    this.kafkaProducer.emit('driver.location.updated', {
      driverId, regionId, tenantId,
      lat: dto.lat, lng: dto.lng,
      heading: dto.heading, speed: dto.speed,
      ts: dto.timestamp,
    }).catch((err) => this.logger.warn({ err, driverId }, 'Failed to emit location event'));
  }

  private async enforceRateLimit(driverId: string): Promise<void> {
    const key = this.RATE_LIMIT_KEY(driverId);
    const now = Date.now();
    const windowMs = 1000;

    // Sliding window: remove entries older than 1 second
    await this.redis.zremrangebyscore(key, 0, now - windowMs);
    const count = await this.redis.zcard(key);

    if (count >= this.MAX_UPDATES_PER_SEC) {
      throw new TooManyRequestsException('Location update rate limit exceeded');
    }

    // Add current timestamp
    await this.redis.zadd(key, now, `${now}`);
    await this.redis.expire(key, 2);
  }
}
```

### LocationController

```typescript
@Controller('drivers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.DRIVER)
export class LocationController {
  @Post('location')
  @HttpCode(204)  // no body on success, just 204
  async updateLocation(
    @Body() dto: UpdateLocationDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.locationService.updateDriverLocation(
      user.sub, user.regionId, user.tenantId, dto,
    );
  }

  @Post('location/batch')
  @HttpCode(204)
  async batchUpdateLocation(
    @Body() dto: BatchLocationUpdateDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    // Process only the most recent update from the batch for GEO,
    // but emit all to Kafka for audit trail
    const latest = dto.updates.reduce((a, b) => a.timestamp > b.timestamp ? a : b);
    await this.locationService.updateDriverLocation(user.sub, user.regionId, user.tenantId, latest);
    // Emit all to Kafka (non-blocking)
    dto.updates.forEach(u => this.locationService.emitLocationEvent(user.sub, user.regionId, u));
  }
}
```

### PostgreSQL Snapshot Consumer (apps/worker)

```typescript
@Injectable()
export class DriverLocationConsumer implements OnModuleInit {
  async onModuleInit() {
    await this.kafka.subscribe({ topic: 'driver.location.updated', fromBeginning: false });
    await this.kafka.run({
      eachBatch: async ({ batch }) => {
        // Batch upsert: update last_location for all drivers in batch
        // One DB call for entire batch, not one per event
        const updates = batch.messages.map(msg => JSON.parse(msg.value.toString()));
        await this.batchUpdateLocations(updates);
      },
    });
  }

  private async batchUpdateLocations(updates: LocationEvent[]): Promise<void> {
    // Deduplicate: keep only latest per driverId
    const latest = new Map<string, LocationEvent>();
    for (const u of updates) {
      const existing = latest.get(u.driverId);
      if (!existing || u.ts > existing.ts) latest.set(u.driverId, u);
    }

    if (latest.size === 0) return;

    // Batch upsert via TypeORM
    await this.dataSource.createQueryBuilder()
      .update(DriverEntity)
      .set({ lastKnownLat: () => 'CASE id ' + [...latest.values()].map(u => `WHEN '${u.driverId}' THEN ${u.lat}`).join(' ') + ' END' })
      // ... similar for lng, lastLocationAt
      .where('id IN (:...ids)', { ids: [...latest.keys()] })
      .execute();
  }
}
```

### Stale Driver Cleanup Cron (apps/worker)

```typescript
@Injectable()
export class DriverStaleCron {
  @Cron('*/2 * * * *')  // every 2 minutes
  async cleanupStaleDrivers(): Promise<void> {
    // Find drivers not seen in 5 minutes
    const staleThreshold = Date.now() - 5 * 60 * 1000;
    const regions = await this.regionService.getActiveRegions();

    for (const region of regions) {
      // GEORADIUS returns all members — scan and check lastSeen in status hash
      // This is O(n) over active drivers, acceptable at 2min interval
      const driverIds = await this.redis.zrange(`drivers:geo:${region.id}`, 0, -1);

      const stalePipeline = this.redis.pipeline();
      for (const driverId of driverIds) {
        stalePipeline.hget(`driver:status:${driverId}`, 'lastSeen');
      }
      const results = await stalePipeline.exec();

      const toRemove: string[] = [];
      for (let i = 0; i < driverIds.length; i++) {
        const lastSeen = results[i][1] as string;
        if (!lastSeen || parseInt(lastSeen) < staleThreshold) {
          toRemove.push(driverIds[i]);
        }
      }

      if (toRemove.length > 0) {
        await this.redis.zrem(`drivers:geo:${region.id}`, ...toRemove);
        this.logger.log(`Removed ${toRemove.length} stale drivers from region ${region.id}`);
      }
    }
  }
}
```

### Performance Considerations

- Use `pipeline()` for all multi-command Redis operations (saves round trips)
- Batch location consumer: use `eachBatch` not `eachMessage` (50x throughput improvement)
- POST /drivers/location returns 204 (no body = faster response)
- Rate limit enforced at Redis level, not DB
- Socket.IO broadcast to ride room only if driver has active ride (Redis lookup O(1))

### Load Testing

After implementation, validate with k6:
```javascript
// k6/location-update.js
export default function() {
  http.post('/drivers/location', JSON.stringify({ lat: 12.9716, lng: 77.5946, heading: 45, speed: 30, timestamp: Date.now() }), {
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` }
  });
}
// Target: 200k req/sec across cluster
```

### Unit Tests

```typescript
describe('LocationService', () => {
  it('updates Redis GEO without touching PostgreSQL')
  it('enforces rate limit: blocks 3rd update in 1 second')
  it('broadcasts to rider when driver has active ride')
  it('fires Kafka event without awaiting it')
  it('does not throw if Redis pipeline fails (graceful degradation)')
})

describe('DriverLocationConsumer', () => {
  it('deduplicates locations: keeps latest per driver')
  it('batch upserts all locations in one DB call')
})
```

## Update Progress

Check off all Location Tracking items in PROJECT_PROGRESS.md.
Mark Phase 2 complete if realtime gateway is also done.
