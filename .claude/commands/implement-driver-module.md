# /implement-driver-module

Implement the Driver domain module. Prerequisite: auth module complete.

## What to Build

### File Structure

```
apps/api/src/modules/driver/
  driver.module.ts
  driver.controller.ts
  driver.service.ts
  driver-availability.service.ts   ← separate service, handles Redis geo ops
  dto/
    update-driver.dto.ts
    update-availability.dto.ts
    driver-response.dto.ts
    earnings-query.dto.ts
  entities/
    driver.entity.ts
    vehicle.entity.ts
    driver-document.entity.ts
  events/
    driver-event.types.ts
  interfaces/
    driver.interface.ts
  exceptions/
    driver.exceptions.ts
  tests/
    driver.service.spec.ts
    driver-availability.service.spec.ts
```

### DriverEntity

```typescript
@Entity('drivers')
@Index(['tenantId', 'regionId', 'status'])
@Index(['userId'], { unique: true })
export class DriverEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @OneToOne(() => UserEntity)
  @JoinColumn({ name: 'userId' })
  user: UserEntity;

  @Column({ type: 'enum', enum: DriverStatus, default: DriverStatus.OFFLINE })
  status: DriverStatus;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 5.0 })
  rating: number;

  @Column({ default: 0 })
  totalTrips: number;

  @Column({ default: 0 })
  totalCancelledTrips: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  acceptanceRate: number;  // percentage

  @Column({ nullable: true })
  lastKnownLat: number;    // updated async by Kafka consumer

  @Column({ nullable: true })
  lastKnownLng: number;

  @Column({ nullable: true })
  lastLocationAt: Date;

  @Column({ nullable: true })
  licenseNumber: string;

  @Column({ nullable: true })
  licenseExpiryDate: Date;

  @Column({ default: false })
  isVerified: boolean;     // admin-verified documents

  @Column({ nullable: true })
  profileImageUrl: string;

  @OneToMany(() => VehicleEntity, (v) => v.driver)
  vehicles: VehicleEntity[];

  @Column({ nullable: true, type: 'uuid' })
  activeVehicleId: string;  // currently selected vehicle
}
```

### VehicleEntity

```typescript
@Entity('vehicles')
@Index(['tenantId', 'driverId'])
export class VehicleEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  driverId: string;

  @ManyToOne(() => DriverEntity, (d) => d.vehicles)
  @JoinColumn({ name: 'driverId' })
  driver: DriverEntity;

  @Column()
  make: string;            // Toyota, Honda

  @Column()
  model: string;           // Innova, City

  @Column()
  year: number;

  @Column({ unique: true })
  licensePlate: string;

  @Column({ type: 'enum', enum: VehicleType })
  type: VehicleType;       // ECONOMY | PREMIUM | XL | AUTO | BIKE

  @Column({ nullable: true })
  color: string;

  @Column({ default: true })
  isActive: boolean;
}
```

### DriverStatus Enum

```typescript
export enum DriverStatus {
  OFFLINE = 'OFFLINE',
  AVAILABLE = 'AVAILABLE',    // online + no ride
  ON_TRIP = 'ON_TRIP',        // actively on a ride
  BUSY = 'BUSY',              // en route to pickup
}
```

### DriverAvailabilityService — Redis Geo Operations

This is critical. All Redis GEO operations go here.

```typescript
@Injectable()
export class DriverAvailabilityService {
  constructor(
    @InjectRedis() private redis: Redis,
    private kafkaProducer: KafkaProducerService,
  ) {}

  async goOnline(driver: DriverEntity, lat: number, lng: number): Promise<void> {
    const pipeline = this.redis.pipeline();
    // Add to geo index
    pipeline.geoadd(`drivers:geo:${driver.regionId}`, lng, lat, driver.id);
    // Set status hash
    pipeline.hset(`driver:status:${driver.id}`, {
      status: DriverStatus.AVAILABLE,
      lastSeen: Date.now(),
      vehicleType: await this.getDriverVehicleType(driver.id),
      tenantId: driver.tenantId,
      regionId: driver.regionId,
    });
    await pipeline.exec();
  }

  async goOffline(driverId: string, regionId: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.zrem(`drivers:geo:${regionId}`, driverId);
    pipeline.del(`driver:status:${driverId}`);
    pipeline.del(`driver:active-ride:${driverId}`);
    await pipeline.exec();
  }

  async updateLocation(driverId: string, regionId: string, lat: number, lng: number): Promise<void> {
    // MUST NOT touch PostgreSQL — Redis only
    const pipeline = this.redis.pipeline();
    pipeline.geoadd(`drivers:geo:${regionId}`, lng, lat, driverId);
    pipeline.hset(`driver:status:${driverId}`, { lastLat: lat, lastLng: lng, lastSeen: Date.now() });
    await pipeline.exec();
    // Emit async Kafka event for PostgreSQL snapshot update (non-blocking)
    this.kafkaProducer.emit('driver.location.updated', { driverId, regionId, lat, lng });
  }

  async getDriverStatus(driverId: string): Promise<DriverStatusRecord | null> {
    const data = await this.redis.hgetall(`driver:status:${driverId}`);
    if (!data || !data.status) return null;
    return data as unknown as DriverStatusRecord;
  }
}
```

### DriverService Methods

**updateAvailability(userId, tenantId, dto)**
- dto: { status: 'ONLINE' | 'OFFLINE', lat, lng }
- 'ONLINE' → call driverAvailabilityService.goOnline, update DB status=AVAILABLE
- 'OFFLINE' → call driverAvailabilityService.goOffline, update DB status=OFFLINE
- Cannot go ONLINE without activeVehicleId set
- Cannot go ONLINE if not verified (isVerified=false)
- DB update wrapped in transaction

**getEarnings(userId, tenantId, query)**
- Aggregate completed trips by date range
- Return: { total, trips: [{ date, amount, tripId }], breakdown: { cash, card, wallet } }

**selectActiveVehicle(userId, tenantId, vehicleId)**
- Verify vehicle belongs to driver
- Update driver.activeVehicleId

### Controller Endpoints

```
GET    /drivers/me                     → getProfile (DRIVER)
PATCH  /drivers/me                     → updateProfile (DRIVER)
POST   /drivers/me/availability        → updateAvailability (DRIVER)
GET    /drivers/me/trips               → getTripHistory paginated (DRIVER)
GET    /drivers/me/earnings            → getEarnings (DRIVER)
POST   /drivers/me/vehicles            → addVehicle (DRIVER)
PATCH  /drivers/me/vehicles/:id/select → selectActiveVehicle (DRIVER)

Admin only:
GET    /admin/drivers                  → listDrivers paginated (ADMIN)
PATCH  /admin/drivers/:id/verify       → verifyDriver (ADMIN)
PATCH  /admin/drivers/:id/suspend      → suspendDriver (ADMIN)
```

### Kafka Event Emitted When Driver Goes Online/Offline

```typescript
// driver-event.types.ts
export interface DriverAvailabilityChangedEvent {
  driverId: string;
  tenantId: string;
  regionId: string;
  status: DriverStatus;
  lat?: number;
  lng?: number;
  vehicleType?: VehicleType;
}
// Topic: driver.availability.changed
```

### Unit Tests

```typescript
describe('DriverAvailabilityService', () => {
  it('geoadds driver on goOnline')
  it('removes from geo set on goOffline')
  it('updates geo and status on location update without touching DB')
  it('does not await Kafka emit (fire and forget)')
})

describe('DriverService', () => {
  it('blocks going online without active vehicle')
  it('blocks going online if not verified')
  it('updates DB status on availability change')
  it('returns paginated trip history')
})
```

## Update Progress

Check off all Driver Module items in PROJECT_PROGRESS.md.
