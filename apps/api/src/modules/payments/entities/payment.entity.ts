import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@gocomet/database';
import { PaymentStatus } from '@gocomet/common';

@Entity('payments')
@Index(['tenantId', 'tripId'])
@Index(['tenantId', 'idempotencyKey'], { unique: true })
export class PaymentEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  tripId: string;

  @Column({ type: 'uuid' })
  riderId: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ default: 'INR' })
  currency: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status: PaymentStatus;

  @Column({ type: 'varchar', nullable: true })
  pspReference: string | null;

  @Column({ type: 'varchar', nullable: true })
  failureReason: string | null;

  @Column()
  idempotencyKey: string;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;
}
