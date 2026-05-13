import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@gocomet/database';

@Entity('regions')
@Index(['tenantId', 'name'])
export class RegionEntity extends BaseEntity {
  @Column()
  name: string;

  @Column({ length: 3 })
  countryCode: string;

  @Column({ default: 'Asia/Kolkata' })
  timezone: string;

  @Column({ type: 'jsonb', default: '{}' })
  config: Record<string, unknown>;

  @Column({ default: true })
  isActive: boolean;
}
