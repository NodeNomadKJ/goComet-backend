# /implement-ride-request

Implement ride creation, fare estimation, and ride lifecycle entry point.
Prerequisite: rider module + driver module complete.

## What to Build

### File Structure

```
apps/api/src/modules/ride/
  ride.module.ts
  ride.controller.ts
  ride.service.ts
  fare.service.ts          ← isolated fare calculation logic
  idempotency.service.ts   ← shared idempotency handling
  dto/
    create-ride.dto.ts
    fare-estimate.dto.ts
    fare-estimate-response.dto.ts
    ride-response.dto.ts
  entities/
    ride.entity.ts
  events/
    ride-event.types.ts
  exceptions/
    ride.exceptions.ts
  tests/
    ride.service.spec.ts
    fare.service.spec.ts
    idempotency.service.spec.ts
```

### RideEntity

```typescript
@Entity('rides')
@Index(['tenantId', 'regionId', 'status'])
@Index(['riderId', 'status'])
@Index(['idempotencyKey'], { unique: true, where: "idempotency_key IS NOT NULL" })
export class RideEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  riderId: string;

  @ManyToOne(() => RiderEntity)
  @JoinColumn({ name: 'riderId' })
  rider: RiderEntity;

  @Column({ nullable: true, type: 'uuid' })
  driverId: string;

  @Column({ type: 'decimal', precision: 10, scale: 7 })
  pickupLat: number;

  @Column({ type: 'decimal', precision: 10, scale: 7 })
  pickupLng: number;

  @Column({ length: 500 })
  pickupAddress: string;

  @Column({ type: 'decimal', precision: 10, scale: 7 })
  dropLat: number;

  @Column({ type: 'decimal', precision: 10, scale: 7 })
  dropLng: number;

  @Column({ length: 500 })
  dropAddress: string;

  @Column({ type: 'enum', enum: RideStatus, default: RideStatus.REQUESTED })
  status: RideStatus;

  @Column({ type: 'enum', enum: VehicleType })
  vehicleType: VehicleType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  fareEstimate: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 1.0 })
  surgeMultiplier: number;

  @Column({ nullable: true })
  idempotencyKey: string;

  @Column({ nullable: true, type: 'uuid' })
  paymentMethodId: string;

  @Column({ nullable: true, length: 3 })
  currency: string;  // INR, AED, etc.

  @Column({ nullable: true })
  scheduledAt: Date;  // for scheduled rides (Phase 2+)

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;  // extensible, tenant-specific
}
```

### RideStatus Enum (in packages/common)

```typescript
export enum RideStatus {
  REQUESTED = 'REQUESTED',
  MATCHING = 'MATCHING',
  DRIVER_ASSIGNED = 'DRIVER_ASSIGNED',
  DRIVER_ARRIVING = 'DRIVER_ARRIVING',
  DRIVER_ARRIVED = 'DRIVER_ARRIVED',
  RIDE_STARTED = 'RIDE_STARTED',
  COMPLETED = 'COMPLETED',
  PAYMENT_PENDING = 'PAYMENT_PENDING',
  PAYMENT_COMPLETED = 'PAYMENT_COMPLETED',
  CANCELLED = 'CANCELLED',
  FAILED = 'FAILED',
}
```

### FareService — Fare Calculation Logic

```typescript
@Injectable()
export class FareService {
  calculateFare(params: FareCalculationParams): FareBreakdown {
    const { distanceKm, durationMin, vehicleType, surgeMultiplier, tenantFareConfig } = params;

    const config = tenantFareConfig[vehicleType];
    const baseFare = config.baseFare;
    const distanceFare = distanceKm * config.perKmRate;
    const timeFare = durationMin * config.perMinRate;
    const subtotal = baseFare + distanceFare + timeFare;
    const surgedFare = subtotal * surgeMultiplier;
    const taxes = surgedFare * config.taxRate;
    const total = Math.round((surgedFare + taxes) * 100) / 100;

    return {
      baseFare,
      distanceFare,
      timeFare,
      surgeMultiplier,
      taxes,
      total,
      currency: tenantFareConfig.currency,
      breakdown: { perKm: config.perKmRate, perMin: config.perMinRate },
    };
  }

  estimateDistanceAndDuration(pickupLat, pickupLng, dropLat, dropLng): { km: number; min: number } {
    // Phase 1: Haversine formula for straight-line distance
    // Phase 3+: replace with routing API (OSRM or Google Maps)
    const R = 6371;
    const dLat = this.toRad(dropLat - pickupLat);
    const dLng = this.toRad(dropLng - pickupLng);
    const a = Math.sin(dLat/2)**2 +
              Math.cos(this.toRad(pickupLat)) * Math.cos(this.toRad(dropLat)) *
              Math.sin(dLng/2)**2;
    const km = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const min = (km / 30) * 60;  // assume 30 km/h average
    return { km: Math.round(km * 100) / 100, min: Math.round(min) };
  }

  private toRad(deg: number) { return deg * (Math.PI / 180); }
}
```

### IdempotencyService

```typescript
@Injectable()
export class IdempotencyService {
  constructor(@InjectRedis() private redis: Redis) {}

  private key(endpoint: string, idempotencyKey: string) {
    return `idempotency:${endpoint}:${idempotencyKey}`;
  }

  async getStoredResponse(endpoint: string, key: string): Promise<unknown | null> {
    const stored = await this.redis.get(this.key(endpoint, key));
    return stored ? JSON.parse(stored) : null;
  }

  async storeResponse(endpoint: string, key: string, response: unknown): Promise<void> {
    const TTL = 24 * 60 * 60; // 24 hours
    await this.redis.set(this.key(endpoint, key), JSON.stringify(response), 'EX', TTL);
  }
}
```

### RideService Methods

**createRide(riderId, tenantId, regionId, dto, idempotencyKey)**

Flow:
1. Check idempotency: if key exists in Redis → return cached response immediately
2. Validate rider exists and is not currently on another active ride
3. Get surge multiplier from Redis: `surge:{regionId}:{zone}` (default 1.0 if missing)
4. Calculate fare estimate using FareService
5. Create RideEntity in DB (status=REQUESTED, idempotencyKey)
6. Cache response in Redis with idempotencyKey (TTL 24h)
7. Emit Kafka event: `ride.request.created`
8. Return ride

**getFareEstimate(dto, tenantId, regionId)**
- No DB write — pure calculation
- Read surge from Redis
- Return FareBreakdown for all vehicle types in one call
- Cache result in Redis for 30s: `fare:estimate:{hash(dto)}`

**getRide(rideId, userId, tenantId)**
- Find ride, verify ownership (riderId or driverId matches userId)
- Return ride with current status

**cancelRide(rideId, riderId, tenantId)**
- Fetch ride, verify ownership
- Allowed cancellation states: REQUESTED, MATCHING, DRIVER_ASSIGNED
- Cannot cancel if RIDE_STARTED (must use trip cancel with fee)
- Update status to CANCELLED
- Emit Kafka event: `ride.request.cancelled`
- If driver was assigned: emit `driver.assignment.cancelled`

### Controller

```typescript
@Controller('rides')
@UseGuards(JwtAuthGuard)
export class RideController {
  @Post()
  @Roles(UserRole.RIDER)
  async createRide(
    @Body() dto: CreateRideDto,
    @CurrentUser() user: JwtPayload,
    @Headers('x-idempotency-key') idempotencyKey: string,
  ) {
    // idempotencyKey is REQUIRED — throw 400 if missing
    if (!idempotencyKey) throw new BadRequestException('X-Idempotency-Key header is required');
    return this.rideService.createRide(user.sub, user.tenantId, user.regionId, dto, idempotencyKey);
  }

  @Post('fare-estimate')
  @Roles(UserRole.RIDER)
  fareEstimate(@Body() dto: FareEstimateDto, @CurrentUser() user: JwtPayload) {
    return this.fareService.getFareEstimate(dto, user.tenantId, user.regionId);
  }

  @Get(':id')
  getRide(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.rideService.getRide(id, user.sub, user.tenantId);
  }

  @Delete(':id/cancel')
  @Roles(UserRole.RIDER)
  cancelRide(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtPayload) {
    return this.rideService.cancelRide(id, user.sub, user.tenantId);
  }
}
```

### CreateRideDto

```typescript
export class CreateRideDto {
  @IsNumber() @Min(-90) @Max(90)
  pickupLat: number;

  @IsNumber() @Min(-180) @Max(180)
  pickupLng: number;

  @IsString() @MaxLength(500)
  pickupAddress: string;

  @IsNumber() @Min(-90) @Max(90)
  dropLat: number;

  @IsNumber() @Min(-180) @Max(180)
  dropLng: number;

  @IsString() @MaxLength(500)
  dropAddress: string;

  @IsEnum(VehicleType)
  vehicleType: VehicleType;

  @IsOptional() @IsUUID()
  paymentMethodId?: string;
}
```

### Kafka Events Emitted

```typescript
// ride.request.created — consumed by MatchingConsumer (Phase 3)
interface RideRequestCreatedEvent {
  rideId: string;
  riderId: string;
  tenantId: string;
  regionId: string;
  pickupLat: number;
  pickupLng: number;
  vehicleType: VehicleType;
  fareEstimate: number;
  surgeMultiplier: number;
}
```

### Unit Tests

```typescript
describe('FareService', () => {
  it('calculates base + distance + time fare correctly')
  it('applies surge multiplier')
  it('calculates haversine distance accurately')
  it('returns separate breakdown by vehicle type')
})

describe('IdempotencyService', () => {
  it('returns null for unknown key')
  it('stores and retrieves response')
  it('expires after 24h (mock TTL check)')
})

describe('RideService', () => {
  it('creates ride and emits kafka event')
  it('returns cached response on duplicate idempotency key')
  it('rejects ride creation if rider already has active ride')
  it('cancels ride in REQUESTED state')
  it('throws when cancelling RIDE_STARTED ride')
})
```

## Update Progress

Check off all Ride Request items in PROJECT_PROGRESS.md.
Mark Phase 1 complete once all 5 modules are done.
