# /implement-surge-pricing

Implement Redis-based dynamic surge pricing. Surge is never calculated per request.
A background job maintains zone multipliers; fare estimation reads from Redis.
Prerequisite: multi-tenant config, ride request module.

## Architecture

```
Every 30 seconds (cron job):
  For each active region:
    → count active ride requests (status=REQUESTED/MATCHING) per zone
    → count available drivers per zone (Redis GEO + status filter)
    → compute demand/supply ratio
    → apply multiplier curve (with tenant cap)
    → write to Redis: surge:{regionId}:{zoneId} TTL 60s

GET /rides/fare-estimate:
    → reads surge from Redis (< 1ms)
    → applies to fare calculation

POST /rides (create):
    → reads surge from Redis at ride creation time
    → locks in the multiplier for that ride
```

## What to Build

### File Structure

```
apps/worker/src/modules/surge/
  surge.module.ts
  surge.cron.ts              ← the 30s job
  surge.service.ts           ← calculation logic
  zone.service.ts            ← zone definitions + H3 binning
  interfaces/
    surge.interface.ts

apps/api/src/modules/surge/
  surge-read.service.ts      ← read-only, used by fare estimation
  surge.controller.ts        ← GET /regions/:id/surge-map
```

### Zone Strategy

Use simple grid-based zones (Phase 5 — upgrade to H3 later):

```typescript
interface Zone {
  id: string;           // e.g., "BLR:12.9716:77.5946:2km"
  regionId: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
}

// For Phase 5: use H3 geospatial indexing
// import { latLngToCell, cellToBoundary } from 'h3-js';
// resolution 8 = ~0.7 km² hexagons
```

### SurgeService — Multiplier Calculation

```typescript
@Injectable()
export class SurgeService {
  calculateMultiplier(activeRequests: number, availableDrivers: number, config: TenantConfig): number {
    if (availableDrivers === 0 && activeRequests === 0) return 1.0;

    const ratio = availableDrivers === 0
      ? activeRequests * 2  // no drivers = max surge
      : activeRequests / availableDrivers;

    // Piecewise multiplier curve
    let multiplier: number;
    if (ratio <= 0.5) multiplier = 1.0;         // more supply than demand
    else if (ratio <= 1.0) multiplier = 1.2;    // balanced
    else if (ratio <= 1.5) multiplier = 1.5;
    else if (ratio <= 2.0) multiplier = 1.8;
    else if (ratio <= 3.0) multiplier = 2.2;
    else multiplier = 2.5;

    // Apply tenant cap (from tenant config)
    return Math.min(multiplier, config.maxSurgeMultiplier ?? 3.0);
  }
}
```

### SurgeCron — The 30s Job

```typescript
@Injectable()
export class SurgeCron {
  @Cron('*/30 * * * * *')  // every 30 seconds
  async updateSurgeMultipliers(): Promise<void> {
    const regions = await this.regionService.getActiveRegions();

    await Promise.all(regions.map(region => this.updateRegionSurge(region)));
  }

  private async updateRegionSurge(region: RegionEntity): Promise<void> {
    const tenant = await this.tenantConfigService.getTenantById(region.tenantId);
    if (!tenant.config.surgeEnabled) return;

    const zones = this.zoneService.getZonesForRegion(region.id);

    await Promise.all(zones.map(async (zone) => {
      const [activeRequests, availableDrivers] = await Promise.all([
        this.countActiveRequestsInZone(region.id, zone),
        this.countAvailableDriversInZone(region.id, zone),
      ]);

      const multiplier = this.surgeService.calculateMultiplier(
        activeRequests, availableDrivers, tenant.config,
      );

      const key = `surge:${region.id}:${zone.id}`;
      await this.redis.set(key, multiplier.toFixed(2), 'EX', 60);

      // Track history for analytics (async, non-blocking)
      if (multiplier > 1.0) {
        this.saveSurgeHistory(region, zone, multiplier, activeRequests, availableDrivers);
      }
    }));
  }

  private async countAvailableDriversInZone(regionId: string, zone: Zone): Promise<number> {
    const driverIds = await this.redis.georadius(
      `drivers:geo:${regionId}`,
      zone.centerLng, zone.centerLat,
      zone.radiusKm, 'km',
      'COUNT', 100,
    ) as string[];

    if (!driverIds.length) return 0;

    // Check which are actually AVAILABLE
    const pipeline = this.redis.pipeline();
    for (const id of driverIds) pipeline.hget(`driver:status:${id}`, 'status');
    const results = await pipeline.exec();

    return results.filter(r => r[1] === 'AVAILABLE').length;
  }

  private async countActiveRequestsInZone(regionId: string, zone: Zone): Promise<number> {
    // Count rides in REQUESTED/MATCHING state within zone (approximate with tenant/region filter)
    return this.rideRepo.count({
      where: {
        regionId,
        status: In([RideStatus.REQUESTED, RideStatus.MATCHING]),
        // Phase 5+: add geospatial filter for zone bounds
      },
    });
  }
}
```

### SurgeReadService (api app)

```typescript
@Injectable()
export class SurgeReadService {
  async getSurgeForLocation(regionId: string, lat: number, lng: number): Promise<number> {
    const zoneId = this.zoneService.getZoneForCoordinate(regionId, lat, lng);
    if (!zoneId) return 1.0;

    const key = `surge:${regionId}:${zoneId}`;
    const value = await this.redis.get(key);
    return value ? parseFloat(value) : 1.0;  // default 1.0 if no surge data
  }

  async getSurgeMap(regionId: string): Promise<SurgeZoneData[]> {
    const zones = this.zoneService.getZonesForRegion(regionId);
    const pipeline = this.redis.pipeline();
    for (const zone of zones) pipeline.get(`surge:${regionId}:${zone.id}`);
    const results = await pipeline.exec();

    return zones.map((zone, i) => ({
      ...zone,
      multiplier: results[i][1] ? parseFloat(results[i][1] as string) : 1.0,
    }));
  }
}
```

### Integration with Fare Estimation

```typescript
// In FareService.getFareEstimate():
const surgeMultiplier = await this.surgeReadService.getSurgeForLocation(
  regionId, dto.pickupLat, dto.pickupLng,
);
// Used in fare calculation, locked in at ride creation time
```

### Surge History Entity (analytics only)

```typescript
@Entity('surge_history')
@Index(['regionId', 'createdAt'])
export class SurgeHistoryEntity {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'uuid' }) tenantId: string;
  @Column({ type: 'uuid' }) regionId: string;
  @Column() zoneId: string;
  @Column({ type: 'decimal', precision: 5, scale: 2 }) multiplier: number;
  @Column() activeRequests: number;
  @Column() availableDrivers: number;
  @CreateDateColumn() createdAt: Date;
}
```

### Surge Map API

```typescript
@Get('regions/:id/surge-map')
async getSurgeMap(@Param('id') regionId: string) {
  return this.surgeReadService.getSurgeMap(regionId);
}
```

### Unit Tests

```typescript
describe('SurgeService', () => {
  it('returns 1.0 when drivers >= 2x requests')
  it('returns 1.2 on balanced demand/supply')
  it('returns 2.5 max when ratio > 3.0')
  it('caps multiplier at tenant maxSurgeMultiplier')
  it('returns 1.0 when both requests and drivers are 0')
  it('handles division by zero when availableDrivers = 0')
})

describe('SurgeCron', () => {
  it('skips region if surge disabled in tenant config')
  it('writes to Redis with 60s TTL')
  it('counts only AVAILABLE drivers in zone')
})

describe('SurgeReadService', () => {
  it('returns 1.0 when no surge data in Redis (TTL expired)')
  it('returns parsed float from Redis')
})
```

## Update Progress

Check off all Surge Pricing items in PROJECT_PROGRESS.md.
