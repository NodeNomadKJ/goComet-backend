import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@gocomet/database';
import { VehicleType } from '@gocomet/common';

export interface RiderPreferences {
  defaultVehicleType: VehicleType;
  defaultPaymentMethodId: string | null;
}

const DEFAULT_PREFERENCES: RiderPreferences = {
  defaultVehicleType: VehicleType.ECONOMY,
  defaultPaymentMethodId: null,
};

@Entity('riders')
@Index(['tenantId', 'userId'], { unique: true })
@Index(['tenantId', 'regionId'])
export class RiderEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 5.0 })
  rating: number;

  @Column({ default: 0 })
  totalRides: number;

  @Column({ type: 'jsonb', default: () => `'${JSON.stringify(DEFAULT_PREFERENCES)}'` })
  preferences: RiderPreferences;
}
