# /implement-trip-state-machine

Implement the complete trip lifecycle state machine. Every state transition must be
validated, transactional, idempotent, and produce a Kafka event.
Prerequisite: matching engine complete (driver assignment creates the trip).

## State Machine

```
[DRIVER_ASSIGNED]
       ↓ driver starts navigating
[DRIVER_ARRIVING]
       ↓ driver reaches pickup
[DRIVER_ARRIVED]
       ↓ rider boards, driver starts trip
[RIDE_STARTED]
       ↓ driver marks trip done
[COMPLETED]
       ↓ (automatic transition via Kafka consumer)
[PAYMENT_PENDING]
       ↓ payment processed
[PAYMENT_COMPLETED]

From any state (except COMPLETED/PAYMENT_COMPLETED):
       → [CANCELLED] with reason + potential fee
       → [FAILED] for system failures
```

## What to Build

### File Structure

```
apps/api/src/modules/trip/
  trip.module.ts
  trip.controller.ts
  trip.service.ts
  trip-state.service.ts     ← pure state machine logic
  cancellation.service.ts   ← cancellation fee logic
  dto/
    trip-response.dto.ts
    cancel-trip.dto.ts
    complete-trip.dto.ts
  entities/
    trip.entity.ts
    trip-event.entity.ts    ← audit log for every transition
  events/
    trip-event.types.ts
  exceptions/
    trip.exceptions.ts
  tests/
    trip-state.service.spec.ts
    trip.service.spec.ts
    cancellation.service.spec.ts
```

### TripEntity

```typescript
@Entity('trips')
@Index(['tenantId', 'regionId', 'status'])
@Index(['rideId'], { unique: true })
@Index(['driverId', 'status'])
@Index(['riderId', 'status'])
export class TripEntity extends BaseEntity {
  @Column({ type: 'uuid', unique: true })
  rideId: string;

  @Column({ type: 'uuid' })
  driverId: string;

  @Column({ type: 'uuid' })
  riderId: string;

  @Column({ type: 'enum', enum: TripStatus, default: TripStatus.DRIVER_ASSIGNED })
  status: TripStatus;

  @Column({ nullable: true })
  driverArrivingAt: Date;

  @Column({ nullable: true })
  driverArrivedAt: Date;

  @Column({ nullable: true })
  startedAt: Date;

  @Column({ nullable: true })
  completedAt: Date;

  @Column({ nullable: true })
  cancelledAt: Date;

  @Column({ type: 'int', nullable: true })
  durationSecs: number;

  @Column({ type: 'decimal', precision: 10, scale: 3, nullable: true })
  distanceKm: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  finalFare: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  cancellationFee: number;

  @Column({ nullable: true })
  cancellationReason: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  paymentStatus: PaymentStatus;

  @Column({ nullable: true })
  idempotencyKey: string;   // for trip.complete idempotency

  @OneToMany(() => TripEventEntity, (e) => e.trip, { eager: false })
  events: TripEventEntity[];
}
```

### TripEventEntity — Audit Log

```typescript
@Entity('trip_events')
@Index(['tenantId', 'tripId'])
export class TripEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  tenantId: string;

  @Column({ type: 'uuid' })
  tripId: string;

  @ManyToOne(() => TripEntity, (t) => t.events)
  @JoinColumn({ name: 'tripId' })
  trip: TripEntity;

  @Column({ type: 'enum', enum: TripStatus })
  fromStatus: TripStatus;

  @Column({ type: 'enum', enum: TripStatus })
  toStatus: TripStatus;

  @Column({ type: 'uuid' })
  actorId: string;          // who triggered the transition

  @Column({ type: 'enum', enum: UserRole })
  actorRole: UserRole;

  @Column({ nullable: true })
  reason: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
```

### TripStateService — Pure State Machine

```typescript
@Injectable()
export class TripStateService {
  // Allowed transitions: from → [allowed tos]
  private readonly ALLOWED_TRANSITIONS: Record<TripStatus, TripStatus[]> = {
    [TripStatus.DRIVER_ASSIGNED]: [TripStatus.DRIVER_ARRIVING, TripStatus.CANCELLED],
    [TripStatus.DRIVER_ARRIVING]: [TripStatus.DRIVER_ARRIVED, TripStatus.CANCELLED],
    [TripStatus.DRIVER_ARRIVED]:  [TripStatus.RIDE_STARTED, TripStatus.CANCELLED],
    [TripStatus.RIDE_STARTED]:    [TripStatus.COMPLETED, TripStatus.FAILED],
    [TripStatus.COMPLETED]:       [TripStatus.PAYMENT_PENDING],
    [TripStatus.PAYMENT_PENDING]: [TripStatus.PAYMENT_COMPLETED, TripStatus.FAILED],
    [TripStatus.PAYMENT_COMPLETED]: [],
    [TripStatus.CANCELLED]:       [],
    [TripStatus.FAILED]:          [],
  };

  validateTransition(from: TripStatus, to: TripStatus): void {
    const allowed = this.ALLOWED_TRANSITIONS[from];
    if (!allowed?.includes(to)) {
      throw new InvalidTripTransitionException(from, to);
    }
  }

  canTransition(from: TripStatus, to: TripStatus): boolean {
    return this.ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
  }

  isFinalState(status: TripStatus): boolean {
    return [TripStatus.PAYMENT_COMPLETED, TripStatus.CANCELLED, TripStatus.FAILED].includes(status);
  }
}
```

### TripService — Transition Handlers

Each transition follows this exact pattern:
1. Load trip + verify ownership
2. Validate state machine transition
3. DB update in transaction + append TripEvent
4. Update Redis active ride status
5. Emit Kafka event
6. Push Socket.IO update to rider

```typescript
async driverArriving(tripId: string, driverId: string, tenantId: string): Promise<TripEntity> {
  return this.executeTransition({
    tripId, actorId: driverId, actorRole: UserRole.DRIVER, tenantId,
    from: TripStatus.DRIVER_ASSIGNED,
    to: TripStatus.DRIVER_ARRIVING,
    update: { driverArrivingAt: new Date() },
    kafkaTopic: 'trip.status.changed',
  });
}

async driverArrived(tripId: string, driverId: string, tenantId: string): Promise<TripEntity> {
  return this.executeTransition({
    tripId, actorId: driverId, actorRole: UserRole.DRIVER, tenantId,
    from: TripStatus.DRIVER_ARRIVED,
    to: TripStatus.DRIVER_ARRIVED,
    update: { driverArrivedAt: new Date() },
    kafkaTopic: 'trip.status.changed',
  });
}

async startRide(tripId: string, driverId: string, tenantId: string): Promise<TripEntity> {
  return this.executeTransition({
    tripId, actorId: driverId, actorRole: UserRole.DRIVER, tenantId,
    from: TripStatus.DRIVER_ARRIVED,
    to: TripStatus.RIDE_STARTED,
    update: { startedAt: new Date() },
    kafkaTopic: 'trip.status.changed',
  });
}

async completeTrip(tripId: string, driverId: string, tenantId: string, dto: CompleteTripDto, idempotencyKey: string): Promise<TripEntity> {
  // Check idempotency first
  const cached = await this.idempotencyService.getStoredResponse('trip.complete', idempotencyKey);
  if (cached) return cached as TripEntity;

  const completedAt = new Date();
  const startedAt = (await this.tripRepo.findOne({ where: { id: tripId } })).startedAt;
  const durationSecs = Math.round((completedAt.getTime() - startedAt.getTime()) / 1000);

  const trip = await this.executeTransition({
    tripId, actorId: driverId, actorRole: UserRole.DRIVER, tenantId,
    from: TripStatus.RIDE_STARTED,
    to: TripStatus.COMPLETED,
    update: { completedAt, durationSecs, distanceKm: dto.distanceKm, finalFare: dto.finalFare },
    kafkaTopic: 'trip.completed',  // triggers payment flow
  });

  await this.idempotencyService.storeResponse('trip.complete', idempotencyKey, trip);

  // Release driver
  await this.redis.del(`driver:active-ride:${driverId}`);
  await this.redis.hset(`driver:status:${driverId}`, 'status', DriverStatus.AVAILABLE);

  return trip;
}

private async executeTransition(params: TransitionParams): Promise<TripEntity> {
  const { tripId, actorId, actorRole, tenantId, from, to, update, kafkaTopic } = params;

  return this.dataSource.transaction(async (em) => {
    // Load with lock to prevent race conditions
    const trip = await em.findOne(TripEntity, {
      where: { id: tripId, tenantId },
      lock: { mode: 'pessimistic_write' },
    });

    if (!trip) throw new TripNotFoundException(tripId);
    this.tripStateService.validateTransition(trip.status, to);
    this.verifyActor(trip, actorId, actorRole);  // driver can only act on their trip

    const updatedTrip = await em.save(TripEntity, { ...trip, ...update, status: to });

    await em.save(TripEventEntity, {
      tenantId, tripId, fromStatus: from, toStatus: to,
      actorId, actorRole, metadata: update,
    });

    // Redis status update (sync, within transaction is ok here)
    await this.redis.hset(`ride:active:${trip.rideId}`, 'status', to);

    // Kafka emit (after DB commit)
    await this.kafkaProducer.emit(kafkaTopic, {
      tripId, rideId: trip.rideId, driverId: trip.driverId,
      riderId: trip.riderId, tenantId, fromStatus: from, toStatus: to,
      ...update,
    });

    // Socket.IO push to rider
    this.realtimeService.emitToRide(trip.rideId, RIDER_EVENTS.RIDE_STATUS, {
      rideId: trip.rideId, status: to,
    });

    return updatedTrip;
  });
}
```

### CancellationService

```typescript
@Injectable()
export class CancellationService {
  calculateCancellationFee(trip: TripEntity, cancelledByRole: UserRole): number {
    if (cancelledByRole === UserRole.DRIVER) return 0;  // driver-fault: no fee for rider
    if (trip.status === TripStatus.DRIVER_ASSIGNED) return 0;  // cancelled before arrival: free
    if (trip.status === TripStatus.DRIVER_ARRIVING) return 0;  // still approaching: free window
    if (trip.status === TripStatus.DRIVER_ARRIVED) return 20;  // driver waiting: small fee
    return 0;
  }
}
```

### Unit Tests (comprehensive — state machines need exhaustive testing)

```typescript
describe('TripStateService', () => {
  describe('validateTransition', () => {
    it('allows DRIVER_ASSIGNED → DRIVER_ARRIVING')
    it('allows DRIVER_ARRIVING → DRIVER_ARRIVED')
    it('allows DRIVER_ARRIVED → RIDE_STARTED')
    it('allows RIDE_STARTED → COMPLETED')
    it('allows COMPLETED → PAYMENT_PENDING')
    it('allows PAYMENT_PENDING → PAYMENT_COMPLETED')
    it('allows any non-final state → CANCELLED')
    it('throws on PAYMENT_COMPLETED → any state')
    it('throws on CANCELLED → any state')
    it('throws on DRIVER_ASSIGNED → RIDE_STARTED (skip)')
    it('throws on RIDE_STARTED → DRIVER_ARRIVING (backward)')
  })
})

describe('TripService', () => {
  it('uses pessimistic lock to prevent race conditions')
  it('appends TripEvent on every transition')
  it('returns idempotent response on duplicate complete call')
  it('frees driver from active ride on completion')
  it('blocks driver from acting on another driver\'s trip')
  it('emits kafka event after DB commit, not before')
})
```

## Update Progress

Check off all Trip State Machine items in PROJECT_PROGRESS.md.
Mark Phase 3 complete if matching engine is also done.
