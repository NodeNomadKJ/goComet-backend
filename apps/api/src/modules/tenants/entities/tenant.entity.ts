import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '@gocomet/database';

@Entity('tenants')
@Index(['slug'], { unique: true })
export class TenantEntity extends BaseEntity {
  @Column()
  name: string;

  @Column({ unique: true })
  slug: string;

  @Column({ type: 'jsonb', default: '{}' })
  config: Record<string, unknown>;

  @Column({ default: 'STANDARD' })
  plan: string;

  @Column({ default: true })
  isActive: boolean;
}
