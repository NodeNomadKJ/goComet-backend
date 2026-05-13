import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@gocomet/database';
import { DriverStatus } from '@gocomet/common';

@Entity('drivers')
@Index(['tenantId', 'userId'], { unique: true })
@Index(['tenantId', 'regionId'])
export class DriverEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'enum', enum: DriverStatus, default: DriverStatus.OFFLINE })
  status: DriverStatus;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 5 })
  rating: number;

  @Column({ default: 0 })
  totalTrips: number;

  @Column({ type: 'uuid', nullable: true })
  activeVehicleId: string | null;

  // Updated async by Kafka consumer — never in request path (Rule 1)
  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  lastLocationLat: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true })
  lastLocationLng: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastLocationUpdatedAt: Date | null;
}
