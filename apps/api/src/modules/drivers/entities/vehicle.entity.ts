import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@gocomet/database';
import { VehicleType } from '@gocomet/common';

@Entity('vehicles')
@Index(['tenantId', 'licensePlate'], { unique: true })
@Index(['tenantId', 'driverId'])
export class VehicleEntity extends BaseEntity {
  @Column({ type: 'uuid' })
  driverId: string;

  @Column()
  make: string;

  @Column()
  model: string;

  @Column()
  year: number;

  @Column()
  licensePlate: string;

  @Column({ type: 'enum', enum: VehicleType })
  type: VehicleType;

  @Column({ type: 'varchar', nullable: true })
  color: string | null;

  @Column({ default: true })
  isActive: boolean;
}
