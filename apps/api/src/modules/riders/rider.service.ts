import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VehicleType } from '@gocomet/common';
import { UserService } from '../users/user.service';
import { RideService } from '../rides/ride.service';
import { RiderEntity } from './entities/rider.entity';
import { RiderPaymentMethodEntity } from './entities/rider-payment-method.entity';
import type { UpdateRiderDto } from './dto/update-rider.dto';
import type { AddPaymentMethodDto } from './dto/add-payment-method.dto';

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class RiderService {
  constructor(
    @InjectRepository(RiderEntity)
    private readonly riderRepo: Repository<RiderEntity>,
    @InjectRepository(RiderPaymentMethodEntity)
    private readonly paymentMethodRepo: Repository<RiderPaymentMethodEntity>,
    private readonly userService: UserService,
    private readonly rideService: RideService,
  ) {}

  async findOrCreateProfile(userId: string, tenantId: string, regionId: string): Promise<RiderEntity> {
    const existing = await this.riderRepo.findOne({ where: { userId, tenantId, isDeleted: false } });
    if (existing) return existing;

    const userExists = await this.userService.findById(userId, tenantId);
    if (!userExists) throw new NotFoundException('User not found');

    const rider = this.riderRepo.create({
      userId,
      tenantId,
      regionId,
      rating: 5,
      totalRides: 0,
      preferences: { defaultVehicleType: VehicleType.ECONOMY, defaultPaymentMethodId: null },
    });
    return this.riderRepo.save(rider);
  }

  async getProfile(userId: string, tenantId: string): Promise<RiderEntity> {
    const rider = await this.riderRepo.findOne({ where: { userId, tenantId, isDeleted: false } });
    if (!rider) throw new NotFoundException('Rider profile not found — complete registration first');
    return rider;
  }

  async updateProfile(userId: string, tenantId: string, dto: UpdateRiderDto): Promise<RiderEntity> {
    const rider = await this.getProfile(userId, tenantId);

    // name / phone live on users table — single source of truth
    if (dto.name !== undefined || dto.phone !== undefined) {
      await this.userService.updateProfile(userId, tenantId, { name: dto.name, phone: dto.phone });
    }

    if (dto.defaultVehicleType !== undefined || dto.defaultPaymentMethodId !== undefined) {
      rider.preferences = {
        ...rider.preferences,
        ...(dto.defaultVehicleType !== undefined && { defaultVehicleType: dto.defaultVehicleType }),
        ...(dto.defaultPaymentMethodId !== undefined && { defaultPaymentMethodId: dto.defaultPaymentMethodId }),
      };
      return this.riderRepo.save(rider);
    }

    return rider;
  }

  async getRideHistory(riderId: string, tenantId: string, page: number, limit: number): Promise<PaginatedResult<unknown>> {
    return this.rideService.getRidesByRider(riderId, tenantId, page, limit);
  }

  async getPaymentMethods(riderId: string, tenantId: string): Promise<RiderPaymentMethodEntity[]> {
    return this.paymentMethodRepo.find({
      where: { riderId, tenantId, isDeleted: false },
      order: { isDefault: 'DESC', createdAt: 'DESC' },
    });
  }

  async addPaymentMethod(
    riderId: string,
    tenantId: string,
    regionId: string,
    dto: AddPaymentMethodDto,
  ): Promise<RiderPaymentMethodEntity> {
    const existingCount = await this.paymentMethodRepo.count({ where: { riderId, tenantId, isDeleted: false } });

    const method = this.paymentMethodRepo.create({
      riderId,
      tenantId,
      regionId,
      type: dto.type,
      provider: dto.provider ?? null,
      maskedDetails: dto.maskedDetails ?? null,
      isDefault: existingCount === 0,
    });

    return this.paymentMethodRepo.save(method);
  }

  async setDefaultPaymentMethod(riderId: string, tenantId: string, methodId: string): Promise<void> {
    await this.paymentMethodRepo.update({ riderId, tenantId }, { isDefault: false });
    const updated = await this.paymentMethodRepo.update(
      { id: methodId, riderId, tenantId },
      { isDefault: true },
    );
    if (updated.affected === 0) throw new NotFoundException('Payment method not found');
  }
}
