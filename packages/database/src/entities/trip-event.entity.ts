import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../base.entity';
import { TripStatus } from '@gocomet/common';

@Entity('trip_events')
@Index(['tripId'])
export class TripEventEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  tripId: string;

  @Column({ type: 'enum', enum: TripStatus, nullable: true })
  fromStatus: TripStatus | null;

  @Column({ type: 'enum', enum: TripStatus })
  toStatus: TripStatus;

  @Column({ type: 'uuid' })
  actorId: string;

  @Column()
  actorRole: string;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, unknown>;
}
