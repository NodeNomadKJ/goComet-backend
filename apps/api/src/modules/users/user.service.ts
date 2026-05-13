import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from './entities/user.entity';
import { UserRole } from '@gocomet/common';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  async findById(id: string, tenantId: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({ where: { id, tenantId, isDeleted: false } });
  }

  async findByEmailWithPassword(
    email: string,
    tenantId: string,
  ): Promise<UserEntity | null> {
    return this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email })
      .andWhere('user.tenantId = :tenantId', { tenantId })
      .andWhere('user.isDeleted = false')
      .getOne();
  }

  async findAdminByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.passwordHash')
      .where('user.email = :email', { email })
      .andWhere('user.role = :role', { role: UserRole.ADMIN })
      .andWhere('user.isDeleted = false')
      .getOne();
  }

  async emailExists(email: string, tenantId: string): Promise<boolean> {
    return this.userRepo.exists({ where: { email, tenantId } });
  }

  async phoneExists(phone: string, tenantId: string): Promise<boolean> {
    return this.userRepo.exists({ where: { phone, tenantId } });
  }

  async create(params: {
    name: string;
    email: string;
    phone: string;
    passwordHash: string;
    role: UserRole;
    tenantId: string;
    regionId: string;
  }): Promise<UserEntity> {
    const user = this.userRepo.create(params);
    return this.userRepo.save(user);
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.userRepo.update(id, { lastLoginAt: new Date() });
  }

  async updateProfile(id: string, tenantId: string, params: { name?: string; phone?: string }): Promise<void> {
    const updates: Partial<UserEntity> = {};
    if (params.name !== undefined) updates.name = params.name;
    if (params.phone !== undefined) updates.phone = params.phone;
    if (Object.keys(updates).length > 0) {
      await this.userRepo.update({ id, tenantId }, updates);
    }
  }
}
