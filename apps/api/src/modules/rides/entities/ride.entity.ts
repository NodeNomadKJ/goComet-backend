import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@gocomet/database';
import { RideStatus, VehicleType } from '@gocomet/common';

@Entity('rides')
@Index(['tenantId', 'riderId'])
@Index(['tenantId', 'regionId'])
@Index(['tenantId', 'idempotencyKey'], { unique: true })
// Covers getActiveRideByRider (status NOT IN terminals) and getRidesByRider (status IN terminals)
@Index(['tenantId', 'riderId', 'status'])
// Covers driver assignment queries in matching/trip flows
@Index(['tenantId', 'driverId', 'status'])
export class RideEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  riderId: string;

  @Column({ type: 'uuid', nullable: true })
  driverId: string | null;

  @Column({ type: 'enum', enum: RideStatus, default: RideStatus.REQUESTED })
  status: RideStatus;

  // Pickup
  @Column({ type: 'decimal', precision: 10, scale: 7 })
  pickupLat: number;

  @Column({ type: 'decimal', precision: 10, scale: 7 })
  pickupLng: number;

  @Column()
  pickupAddress: string;

  // Drop-off
  @Column({ type: 'decimal', precision: 10, scale: 7 })
  dropLat: number;

  @Column({ type: 'decimal', precision: 10, scale: 7 })
  dropLng: number;

  @Column()
  dropAddress: string;

  @Column({ type: 'enum', enum: VehicleType, default: VehicleType.ECONOMY })
  vehicleType: VehicleType;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  fareEstimate: number;

  @Column({ type: 'decimal', precision: 4, scale: 2, default: 1.0 })
  surgeMultiplier: number;

  @Column({ type: 'varchar', nullable: true })
  cancellationReason: string | null;

  // Idempotency key scoped to tenant — unique index above enforces replay safety
  @Column()
  idempotencyKey: string;
}
