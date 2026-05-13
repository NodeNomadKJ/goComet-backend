import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@gocomet/database';
import { TripStatus, PaymentStatus } from '@gocomet/common';

@Entity('trips')
@Index(['tenantId', 'rideId'], { unique: true })
@Index(['tenantId', 'driverId'])
@Index(['tenantId', 'riderId'])
export class TripEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  rideId: string;

  @Column({ type: 'uuid' })
  driverId: string;

  @Column({ type: 'uuid' })
  riderId: string;

  @Column({ type: 'enum', enum: TripStatus, default: TripStatus.DRIVER_ASSIGNED })
  status: TripStatus;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ type: 'int', nullable: true })
  durationSecs: number | null;

  @Column({ type: 'decimal', precision: 8, scale: 3, nullable: true })
  distanceKm: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  finalFare: number | null;

  @Column({ type: 'varchar', nullable: true })
  cancellationReason: string | null;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  cancellationFee: number | null;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  paymentStatus: PaymentStatus;
}
