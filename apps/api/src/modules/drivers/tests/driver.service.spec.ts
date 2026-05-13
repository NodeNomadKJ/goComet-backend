import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DriverService } from '../driver.service';
import { DriverEntity } from '../entities/driver.entity';
import { VehicleEntity } from '../entities/vehicle.entity';
import { UserService } from '../../users/user.service';
import { REDIS_CLIENT } from '@gocomet/redis';
import { DriverStatus, VehicleType } from '@gocomet/common';

const mockDriverRepo = {
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
};

const mockVehicleRepo = {
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
  exists: jest.fn(),
};

const mockUserService = { findById: jest.fn() };

const mockRedis = {
  geoadd: jest.fn().mockResolvedValue(1),
  hset: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1),
  zrem: jest.fn().mockResolvedValue(1),
  del: jest.fn().mockResolvedValue(1),
};

const baseDriver: DriverEntity = {
  id: 'driver-1',
  userId: 'user-1',
  tenantId: 'tenant-1',
  regionId: 'region-1',
  name: 'Bob Driver',
  email: 'bob@example.com',
  phone: '+919876543210',
  status: DriverStatus.OFFLINE,
  rating: 5,
  totalTrips: 0,
  activeVehicleId: null,
  lastLocationLat: null,
  lastLocationLng: null,
  lastLocationUpdatedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  isDeleted: false,
} as DriverEntity;

const baseVehicle: VehicleEntity = {
  id: 'vehicle-1',
  driverId: 'driver-1',
  tenantId: 'tenant-1',
  regionId: 'region-1',
  make: 'Toyota',
  model: 'Innova',
  year: 2022,
  licensePlate: 'DL01AB1234',
  type: VehicleType.XL,
  color: 'White',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  isDeleted: false,
} as VehicleEntity;

describe('DriverService', () => {
  let service: DriverService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DriverService,
        { provide: getRepositoryToken(DriverEntity), useValue: mockDriverRepo },
        { provide: getRepositoryToken(VehicleEntity), useValue: mockVehicleRepo },
        { provide: UserService, useValue: mockUserService },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<DriverService>(DriverService);
  });

  describe('findOrCreateProfile', () => {
    it('returns existing profile without hitting UserService', async () => {
      mockDriverRepo.findOne.mockResolvedValue(baseDriver);

      const result = await service.findOrCreateProfile('user-1', 'tenant-1', 'region-1');

      expect(result).toBe(baseDriver);
      expect(mockUserService.findById).not.toHaveBeenCalled();
    });

    it('creates profile on first access using user data', async () => {
      mockDriverRepo.findOne.mockResolvedValue(null);
      mockUserService.findById.mockResolvedValue({ id: 'user-1', name: 'Bob Driver', email: 'bob@example.com', phone: '+919876543210' });
      mockDriverRepo.create.mockReturnValue(baseDriver);
      mockDriverRepo.save.mockResolvedValue(baseDriver);

      const result = await service.findOrCreateProfile('user-1', 'tenant-1', 'region-1');

      expect(mockUserService.findById).toHaveBeenCalledWith('user-1', 'tenant-1');
      expect(result.status).toBe(DriverStatus.OFFLINE);
    });

    it('throws NotFoundException when user does not exist', async () => {
      mockDriverRepo.findOne.mockResolvedValue(null);
      mockUserService.findById.mockResolvedValue(null);

      await expect(service.findOrCreateProfile('ghost', 'tenant-1', 'region-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('setAvailability — going online', () => {
    it('writes to Redis GEO and status key when going AVAILABLE', async () => {
      mockDriverRepo.findOne.mockResolvedValue({ ...baseDriver, activeVehicleId: 'vehicle-1' });
      mockVehicleRepo.findOne.mockResolvedValue(baseVehicle);
      mockDriverRepo.save.mockImplementation((d: DriverEntity) => Promise.resolve(d));

      await service.setAvailability('user-1', 'tenant-1', 'region-1', {
        status: DriverStatus.AVAILABLE,
        lat: 28.6139,
        lng: 77.209,
      });

      expect(mockRedis.geoadd).toHaveBeenCalledWith(
        'drivers:geo:region-1',
        77.209, 28.6139,
        'driver-1',
      );
      expect(mockRedis.hset).toHaveBeenCalledWith(
        'driver:status:driver-1',
        expect.objectContaining({ status: DriverStatus.AVAILABLE }),
      );
      expect(mockRedis.expire).toHaveBeenCalledWith('driver:status:driver-1', 300);
    });

    it('throws BadRequestException when going online without any vehicle', async () => {
      mockDriverRepo.findOne.mockResolvedValue({ ...baseDriver, activeVehicleId: null });

      await expect(
        service.setAvailability('user-1', 'tenant-1', 'region-1', {
          status: DriverStatus.AVAILABLE,
          lat: 28.6,
          lng: 77.2,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(mockRedis.geoadd).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when specified vehicleId is not found', async () => {
      mockDriverRepo.findOne.mockResolvedValue({ ...baseDriver });
      mockVehicleRepo.findOne.mockResolvedValue(null);

      await expect(
        service.setAvailability('user-1', 'tenant-1', 'region-1', {
          status: DriverStatus.AVAILABLE,
          lat: 28.6,
          lng: 77.2,
          vehicleId: 'bad-vehicle',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('setAvailability — going offline', () => {
    it('removes driver from Redis GEO and deletes status key', async () => {
      mockDriverRepo.findOne.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      mockDriverRepo.save.mockImplementation((d: DriverEntity) => Promise.resolve(d));

      await service.setAvailability('user-1', 'tenant-1', 'region-1', {
        status: DriverStatus.OFFLINE,
      });

      expect(mockRedis.zrem).toHaveBeenCalledWith('drivers:geo:region-1', 'driver-1');
      expect(mockRedis.del).toHaveBeenCalledWith('driver:status:driver-1');
    });
  });

  describe('addVehicle', () => {
    it('registers a new vehicle for the driver', async () => {
      mockDriverRepo.findOne.mockResolvedValue(baseDriver);
      mockVehicleRepo.exists.mockResolvedValue(false);
      mockVehicleRepo.create.mockReturnValue(baseVehicle);
      mockVehicleRepo.save.mockResolvedValue(baseVehicle);

      const result = await service.addVehicle('user-1', 'tenant-1', 'region-1', {
        make: 'Toyota', model: 'Innova', year: 2022,
        licensePlate: 'DL01AB1234', type: VehicleType.XL, color: 'White',
      });

      expect(result.licensePlate).toBe('DL01AB1234');
    });

    it('throws ConflictException for duplicate license plate', async () => {
      mockDriverRepo.findOne.mockResolvedValue(baseDriver);
      mockVehicleRepo.exists.mockResolvedValue(true);

      await expect(
        service.addVehicle('user-1', 'tenant-1', 'region-1', {
          make: 'Honda', model: 'City', year: 2021,
          licensePlate: 'DL01AB1234', type: VehicleType.ECONOMY,
        }),
      ).rejects.toThrow(ConflictException);
    });
  });
});
