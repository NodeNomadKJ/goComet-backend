import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@gocomet/database';

export enum PaymentMethodType {
  CARD = 'CARD',
  UPI = 'UPI',
  WALLET = 'WALLET',
  CASH = 'CASH',
}

@Entity('rider_payment_methods')
@Index(['tenantId', 'riderId'])
export class RiderPaymentMethodEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  riderId: string;

  @Column({ type: 'enum', enum: PaymentMethodType })
  type: PaymentMethodType;

  @Column({ type: 'varchar', nullable: true })
  provider: string | null;

  @Column({ type: 'varchar', nullable: true })
  maskedDetails: string | null;

  @Column({ default: false })
  isDefault: boolean;
}
