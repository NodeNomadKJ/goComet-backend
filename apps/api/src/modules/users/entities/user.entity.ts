import { Column, Entity, Index } from 'typeorm';
import { UserRole } from '@gocomet/common';
import { BaseEntity } from '@gocomet/database';

@Entity('users')
@Index(['tenantId', 'email'], { unique: true })
@Index(['tenantId', 'phone'], { unique: true })
@Index(['tenantId', 'regionId'])
export class UserEntity extends BaseEntity {
  @Column()
  name: string;

  @Column()
  email: string;

  @Column()
  phone: string;

  @Column({ select: false })
  passwordHash: string;

  @Column({ type: 'enum', enum: UserRole })
  role: UserRole;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;
}
