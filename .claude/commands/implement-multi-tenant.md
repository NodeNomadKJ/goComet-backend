# /implement-multi-tenant

Implement multi-tenant isolation: tenant resolution, request scoping, config per tenant,
and DB-level row-level isolation via tenant_id + region_id.
Prerequisite: Phase 4 complete.

## What to Build

### File Structure

```
apps/api/src/modules/tenant/
  tenant.module.ts
  tenant.controller.ts        ← admin CRUD
  tenant.service.ts
  tenant-config.service.ts    ← Redis-cached tenant config
  middleware/
    tenant.middleware.ts       ← resolves tenant from request
  decorators/
    tenant-aware.decorator.ts
  interceptors/
    tenant-scope.interceptor.ts
  entities/
    tenant.entity.ts
    region.entity.ts
  dto/
    create-tenant.dto.ts
    create-region.dto.ts
    tenant-response.dto.ts
  tests/
    tenant.middleware.spec.ts
    tenant-config.service.spec.ts
```

### TenantEntity

```typescript
@Entity('tenants')
@Index(['slug'], { unique: true })
export class TenantEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  slug: string;         // gocomet-india, ola-uae

  @Column()
  name: string;

  @Column({ type: 'enum', enum: TenantPlan })
  plan: TenantPlan;     // STARTER | GROWTH | ENTERPRISE

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'jsonb', default: '{}' })
  config: TenantConfig;

  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;

  @OneToMany(() => RegionEntity, (r) => r.tenant)
  regions: RegionEntity[];
}

interface TenantConfig {
  supportedVehicleTypes: VehicleType[];
  maxSurgeMultiplier: number;        // e.g., 3.0
  surgeEnabled: boolean;
  cancellationPolicy: {
    freeWindowMinutes: number;
    fee: number;
  };
  baseFares: Record<VehicleType, {
    baseFare: number;
    perKmRate: number;
    perMinRate: number;
    taxRate: number;
    currency: string;
  }>;
  features: {
    scheduledRides: boolean;
    sharedRides: boolean;
    luxuryRides: boolean;
  };
}
```

### RegionEntity

```typescript
@Entity('regions')
@Index(['tenantId', 'code'], { unique: true })
export class RegionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @ManyToOne(() => TenantEntity, (t) => t.regions)
  @JoinColumn({ name: 'tenantId' })
  tenant: TenantEntity;

  @Column()
  name: string;            // Bangalore, Mumbai, Dubai

  @Column({ length: 10 })
  code: string;            // BLR, MUM, DXB

  @Column({ length: 2 })
  countryCode: string;     // IN, AE

  @Column()
  timezone: string;        // Asia/Kolkata

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'jsonb', nullable: true })
  bounds: { swLat: number; swLng: number; neLat: number; neLng: number };

  @CreateDateColumn() createdAt: Date;
}
```

### TenantMiddleware — Tenant Resolution

```typescript
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  async use(req: FastifyRequest, res: FastifyReply, next: () => void) {
    // Strategy 1: X-Tenant-ID header (internal services / mobile apps)
    let tenantId = req.headers['x-tenant-id'] as string;

    // Strategy 2: subdomain (gocomet-india.api.gocomet.com)
    if (!tenantId) {
      const host = req.hostname;
      const subdomain = host.split('.')[0];
      if (subdomain && subdomain !== 'api') {
        const tenant = await this.tenantConfigService.getTenantBySlug(subdomain);
        tenantId = tenant?.id;
      }
    }

    // Strategy 3: JWT payload (already authenticated requests)
    // tenantId is embedded in JWT, so this middleware primarily
    // handles unauthenticated routes (register, login, etc.)

    if (!tenantId) {
      throw new BadRequestException('Tenant context required');
    }

    // Validate tenant is active
    const tenant = await this.tenantConfigService.getTenantById(tenantId);
    if (!tenant?.isActive) {
      throw new ForbiddenException('Tenant is inactive');
    }

    // Attach to request for downstream use
    (req as any).tenantId = tenantId;
    (req as any).tenantConfig = tenant.config;
    next();
  }
}
```

### TenantConfigService — Redis-Cached Tenant Config

```typescript
@Injectable()
export class TenantConfigService {
  private readonly TTL = 5 * 60;  // 5 minutes

  async getTenantById(tenantId: string): Promise<TenantEntity | null> {
    const cached = await this.redis.get(`tenant:config:${tenantId}`);
    if (cached) return JSON.parse(cached);

    const tenant = await this.tenantRepo.findOne({
      where: { id: tenantId, isActive: true },
      relations: ['regions'],
    });
    if (tenant) {
      await this.redis.set(`tenant:config:${tenantId}`, JSON.stringify(tenant), 'EX', this.TTL);
    }
    return tenant;
  }

  async getTenantBySlug(slug: string): Promise<TenantEntity | null> {
    const id = await this.redis.get(`tenant:slug:${slug}`);
    if (id) return this.getTenantById(id);

    const tenant = await this.tenantRepo.findOne({ where: { slug, isActive: true } });
    if (tenant) {
      await this.redis.set(`tenant:slug:${slug}`, tenant.id, 'EX', this.TTL);
    }
    return tenant;
  }

  async invalidateCache(tenantId: string): Promise<void> {
    await this.redis.del(`tenant:config:${tenantId}`);
  }

  getBaseFare(config: TenantConfig, vehicleType: VehicleType) {
    return config.baseFares[vehicleType] ?? config.baseFares[VehicleType.ECONOMY];
  }
}
```

### Admin Controller

```typescript
@Controller('admin/tenants')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class TenantController {
  @Post()
  createTenant(@Body() dto: CreateTenantDto) {
    return this.tenantService.createTenant(dto);
  }

  @Post(':id/regions')
  addRegion(@Param('id') tenantId: string, @Body() dto: CreateRegionDto) {
    return this.tenantService.addRegion(tenantId, dto);
  }

  @Patch(':id/config')
  updateConfig(@Param('id') tenantId: string, @Body() config: Partial<TenantConfig>) {
    return this.tenantService.updateConfig(tenantId, config);
  }

  @Patch(':id/suspend')
  suspendTenant(@Param('id') tenantId: string) {
    return this.tenantService.suspend(tenantId);
  }
}
```

### DB Index Audit

After enabling multi-tenancy, verify these indexes exist on every hot table:

```sql
-- rides table
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rides_tenant_region_status
  ON rides (tenant_id, region_id, status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rides_rider_status
  ON rides (rider_id, status) WHERE is_deleted = false;

-- trips table
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trips_tenant_region_status
  ON trips (tenant_id, region_id, status);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trips_driver_status
  ON trips (driver_id, status);

-- drivers table
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_drivers_tenant_region_status
  ON drivers (tenant_id, region_id, status);
```

### Tenant-Level Rate Limiting

```typescript
// Applied per tenant to prevent one tenant starving others
@Injectable()
export class TenantRateLimitGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const tenantId = req.tenantId;

    const key = `ratelimit:tenant:${tenantId}:${Math.floor(Date.now() / 60000)}`; // per minute
    const count = await this.redis.incr(key);
    await this.redis.expire(key, 60);

    const tenant = await this.tenantConfigService.getTenantById(tenantId);
    const limit = this.getPlanLimit(tenant.plan);  // STARTER:1000, GROWTH:5000, ENTERPRISE:50000 rpm

    if (count > limit) throw new TooManyRequestsException('Tenant rate limit exceeded');
    return true;
  }
}
```

### Unit Tests

```typescript
describe('TenantMiddleware', () => {
  it('resolves tenant from X-Tenant-ID header')
  it('resolves tenant from subdomain')
  it('throws BadRequest when no tenant context')
  it('throws Forbidden when tenant is inactive')
})

describe('TenantConfigService', () => {
  it('returns from Redis cache within TTL')
  it('fetches from DB on cache miss and caches result')
  it('invalidates Redis cache on config update')
})
```

## Update Progress

Check off all Multi-Tenant items in PROJECT_PROGRESS.md.
