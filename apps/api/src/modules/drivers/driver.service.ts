import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DriverStatus, VehicleType } from '@gocomet/common';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import { UserService } from '../users/user.service';
import { DriverEntity } from './entities/driver.entity';
import { VehicleEntity } from './entities/vehicle.entity';
import type { UpdateDriverDto } from './dto/update-driver.dto';
import type { AvailabilityDto } from './dto/availability.dto';
import type { AddVehicleDto } from './dto/add-vehicle.dto';

const GEO_KEY = (regionId: string) => `drivers:geo:${regionId}`;
const STATUS_KEY = (driverId: string) => `driver:status:${driverId}`;
const DRIVER_STATUS_TTL = 30 * 60; // 30 minutes — stale driver cleanup

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class DriverService {
  private readonly logger = new Logger(DriverService.name);

  constructor(
    @InjectRepository(DriverEntity)
    private readonly driverRepo: Repository<DriverEntity>,
    @InjectRepository(VehicleEntity)
    private readonly vehicleRepo: Repository<VehicleEntity>,
    @InjectRedis() private readonly redis: Redis,
    private readonly userService: UserService,
  ) {}

  async findOrCreateProfile(userId: string, tenantId: string, regionId: string): Promise<DriverEntity> {
    const existing = await this.driverRepo.findOne({ where: { userId, tenantId, isDeleted: false } });
    if (existing) return existing;

    const userExists = await this.userService.findById(userId, tenantId);
    if (!userExists) throw new NotFoundException('User not found');

    const driver = this.driverRepo.create({
      userId,
      tenantId,
      regionId,
      status: DriverStatus.OFFLINE,
      rating: 5,
      totalTrips: 0,
      activeVehicleId: null,
      lastLocationLat: null,
      lastLocationLng: null,
      lastLocationUpdatedAt: null,
    });

    return this.driverRepo.save(driver);
  }

  async getProfile(userId: string, tenantId: string): Promise<DriverEntity> {
    const driver = await this.driverRepo.findOne({ where: { userId, tenantId, isDeleted: false } });
    if (!driver) throw new NotFoundException('Driver profile not found');
    return driver;
  }

  async updateProfile(userId: string, tenantId: string, dto: UpdateDriverDto): Promise<DriverEntity> {
    const driver = await this.getProfile(userId, tenantId);
    // name / phone live on users table — single source of truth
    if (dto.name !== undefined || dto.phone !== undefined) {
      await this.userService.updateProfile(userId, tenantId, { name: dto.name, phone: dto.phone });
    }
    return driver;
  }

  async setAvailability(userId: string, tenantId: string, regionId: string, dto: AvailabilityDto): Promise<DriverEntity> {
    const driver = await this.getProfile(userId, tenantId);

    if (dto.status === DriverStatus.AVAILABLE) {
      // Use explicit undefined checks so TypeScript narrows the types (no ! or as needed)
      const vehicleId = dto.vehicleId ?? driver.activeVehicleId;
      if (!vehicleId) throw new BadRequestException('A vehicle must be assigned before going online');

      if (dto.lat === undefined || dto.lng === undefined) {
        throw new BadRequestException('lat and lng are required when going online');
      }

      const vehicle = await this.vehicleRepo.findOne({
        where: { id: vehicleId, driverId: driver.id, tenantId, isActive: true, isDeleted: false },
      });
      if (!vehicle) throw new NotFoundException('Vehicle not found or inactive');

      driver.status = DriverStatus.AVAILABLE;
      driver.activeVehicleId = vehicleId;
      await this.driverRepo.save(driver);

      await this.goOnline(driver.id, regionId, dto.lat, dto.lng, vehicle.type);
      // Cache userId → entity ID so the location update hot path avoids DB lookups
      await this.redis.set(`driver:entity:${userId}:${tenantId}`, driver.id, 'EX', 3600);
      this.logger.log({ driverId: driver.id, regionId }, 'Driver went online');
    } else {
      driver.status = DriverStatus.OFFLINE;
      await this.driverRepo.save(driver);

      await this.goOffline(driver.id, regionId);
      this.logger.log({ driverId: driver.id, regionId }, 'Driver went offline');
    }

    return driver;
  }

  async addVehicle(userId: string, tenantId: string, regionId: string, dto: AddVehicleDto): Promise<VehicleEntity> {
    const driver = await this.getProfile(userId, tenantId);

    const plateExists = await this.vehicleRepo.exists({
      where: { licensePlate: dto.licensePlate, tenantId, isDeleted: false },
    });
    if (plateExists) throw new ConflictException('License plate already registered');

    const vehicle = this.vehicleRepo.create({
      driverId: driver.id,
      tenantId,
      regionId,
      make: dto.make,
      model: dto.model,
      year: dto.year,
      licensePlate: dto.licensePlate,
      type: dto.type,
      color: dto.color ?? null,
      isActive: true,
    });

    return this.vehicleRepo.save(vehicle);
  }

  async getVehicles(userId: string, tenantId: string): Promise<VehicleEntity[]> {
    const driver = await this.getProfile(userId, tenantId);
    return this.vehicleRepo.find({
      where: { driverId: driver.id, tenantId, isDeleted: false },
      order: { createdAt: 'DESC' },
    });
  }

  // Stub — wired when trip module is implemented (Phase 3)
  async getTrips(_driverId: string, _tenantId: string, page: number, limit: number): Promise<PaginatedResult<never>> {
    return { data: [], total: 0, page, limit };
  }

  // Stub — wired when payment module is implemented (Phase 4)
  async getEarnings(_driverId: string, _tenantId: string): Promise<{ totalEarnings: number; currency: string }> {
    return { totalEarnings: 0, currency: 'INR' };
  }

  // Called on WebSocket reconnect — re-registers the driver in Redis if their status key expired
  async refreshRedisPresence(driverId: string, regionId: string): Promise<void> {
    const existing = await this.redis.hgetall(STATUS_KEY(driverId));
    if (existing?.status === DriverStatus.AVAILABLE) {
      // Key still live — just bump the TTL
      await this.redis.expire(STATUS_KEY(driverId), DRIVER_STATUS_TTL);
      return;
    }

    const driver = await this.driverRepo.findOne({ where: { id: driverId } });
    if (!driver || driver.status !== DriverStatus.AVAILABLE) return;

    const vehicle = driver.activeVehicleId
      ? await this.vehicleRepo.findOne({ where: { id: driver.activeVehicleId } })
      : null;
    const vehicleType = vehicle?.type ?? VehicleType.ECONOMY;

    // Check if a valid GEO entry already exists in Redis (set by a prior goOnline call)
    const geoPos = await this.redis.geopos(GEO_KEY(regionId), driverId);
    const geoEntry = geoPos?.[0];

    if (geoEntry) {
      // GEO entry is still present — only restore the status hash; don't overwrite correct coordinates
      await this.redis.hset(STATUS_KEY(driverId), {
        status: DriverStatus.AVAILABLE,
        vehicleType,
        regionId,
        lastSeen: String(Date.now()),
      });
      await this.redis.expire(STATUS_KEY(driverId), DRIVER_STATUS_TTL);
      this.logger.log({ driverId, regionId }, 'Driver Redis presence refreshed (status hash only, GEO intact)');
      return;
    }

    // GEO entry gone — fall back to DB coordinates; TypeORM returns decimals as strings so cast explicitly
    const lat = driver.lastLocationLat !== null ? Number(driver.lastLocationLat) : null;
    const lng = driver.lastLocationLng !== null ? Number(driver.lastLocationLng) : null;

    if (lat === null || lng === null) {
      this.logger.warn({ driverId, regionId }, 'Driver GEO entry missing and no DB coordinates — driver must go offline/online again');
      return;
    }

    await this.goOnline(driverId, regionId, lat, lng, vehicleType);
    this.logger.log({ driverId, regionId }, 'Driver Redis presence refreshed on reconnect');
  }

  private async goOnline(driverId: string, regionId: string, lat: number, lng: number, vehicleType: VehicleType): Promise<void> {
    await Promise.all([
      // Add to geospatial index — lng before lat is the Redis GEO convention
      this.redis.geoadd(GEO_KEY(regionId), lng, lat, driverId),
      // Store realtime status with TTL — matching engine reads this
      this.redis.hset(STATUS_KEY(driverId), {
        status: DriverStatus.AVAILABLE,
        vehicleType,
        regionId,
        lastSeen: Date.now(),
      }),
      this.redis.expire(STATUS_KEY(driverId), DRIVER_STATUS_TTL),
    ]);
  }

  private async goOffline(driverId: string, regionId: string): Promise<void> {
    await Promise.all([
      this.redis.zrem(GEO_KEY(regionId), driverId),
      this.redis.del(STATUS_KEY(driverId)),
    ]);
  }
}
