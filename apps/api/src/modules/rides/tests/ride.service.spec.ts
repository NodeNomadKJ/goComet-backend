import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RideService } from '../ride.service';
import { RideEntity } from '../entities/ride.entity';
import { REDIS_CLIENT } from '@gocomet/redis';
import { RideStatus, VehicleType } from '@gocomet/common';

const mockRideRepo = {
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  findAndCount: jest.fn(),
};

const mockRedis = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue('OK'),
};

const baseRide: Partial<RideEntity> = {
  id: 'ride-1',
  riderId: 'rider-1',
  driverId: null,
  tenantId: 'tenant-1',
  regionId: 'region-1',
  status: RideStatus.REQUESTED,
  pickupLat: 28.6139,
  pickupLng: 77.209,
  pickupAddress: 'Connaught Place',
  dropLat: 28.5355,
  dropLng: 77.391,
  dropAddress: 'Noida Sector 18',
  vehicleType: VehicleType.ECONOMY,
  fareEstimate: 150,
  surgeMultiplier: 1,
  idempotencyKey: 'idem-key-1',
  isDeleted: false,
};

describe('RideService', () => {
  let service: RideService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RideService,
        { provide: getRepositoryToken(RideEntity), useValue: mockRideRepo },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<RideService>(RideService);
  });

  describe('estimateFare', () => {
    it('calculates fare with no surge (Redis returns null)', async () => {
      mockRedis.get.mockResolvedValue(null);

      const result = await service.estimateFare(
        { pickupLat: 28.6139, pickupLng: 77.209, dropLat: 28.5355, dropLng: 77.391, vehicleType: VehicleType.ECONOMY },
        'region-1',
      );

      expect(result.surgeMultiplier).toBe(1);
      expect(result.total).toBeGreaterThan(0);
      expect(result.currency).toBe('INR');
      expect(result.distanceKm).toBeGreaterThan(0);
    });

    it('applies surge multiplier from Redis', async () => {
      mockRedis.get.mockResolvedValue('1.5');

      const withoutSurge = await service.estimateFare(
        { pickupLat: 28.6139, pickupLng: 77.209, dropLat: 28.5355, dropLng: 77.391 },
        'region-1',
      );

      // Run again without surge to compare
      mockRedis.get.mockResolvedValue(null);
      const noSurge = await service.estimateFare(
        { pickupLat: 28.6139, pickupLng: 77.209, dropLat: 28.5355, dropLng: 77.391 },
        'region-1',
      );

      expect(withoutSurge.surgeMultiplier).toBe(1.5);
      expect(withoutSurge.total).toBeGreaterThan(noSurge.total);
    });

    it('ECONOMY costs less than PREMIUM for same route', async () => {
      mockRedis.get.mockResolvedValue(null);
      const dto = { pickupLat: 28.6139, pickupLng: 77.209, dropLat: 28.5355, dropLng: 77.391 };

      const economy = await service.estimateFare({ ...dto, vehicleType: VehicleType.ECONOMY }, 'r');
      const premium = await service.estimateFare({ ...dto, vehicleType: VehicleType.PREMIUM }, 'r');

      expect(premium.total).toBeGreaterThan(economy.total);
    });
  });

  describe('createRide', () => {
    it('creates a ride and caches the response for idempotency', async () => {
      mockRedis.get.mockResolvedValue(null); // no cached response
      mockRideRepo.create.mockReturnValue(baseRide);
      mockRideRepo.save.mockResolvedValue(baseRide);

      const result = await service.createRide('rider-1', 'tenant-1', 'region-1', 'idem-key-1', {
        pickupLat: 28.6139, pickupLng: 77.209, pickupAddress: 'Connaught Place',
        dropLat: 28.5355, dropLng: 77.391, dropAddress: 'Noida Sector 18',
      });

      expect(result.status).toBe(RideStatus.REQUESTED);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'idempotency:rides:tenant-1:idem-key-1',
        expect.any(String),
        'EX',
        86400,
      );
    });

    it('returns cached response on idempotent replay without hitting DB', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(baseRide));

      const result = await service.createRide('rider-1', 'tenant-1', 'region-1', 'idem-key-1', {
        pickupLat: 28.6139, pickupLng: 77.209, pickupAddress: 'CP',
        dropLat: 28.5355, dropLng: 77.391, dropAddress: 'Noida',
      });

      expect(result.id).toBe('ride-1');
      expect(mockRideRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('getRide', () => {
    it('returns ride when requester is the rider', async () => {
      mockRideRepo.findOne.mockResolvedValue(baseRide);
      const result = await service.getRide('ride-1', 'tenant-1', 'rider-1');
      expect(result.id).toBe('ride-1');
    });

    it('throws ForbiddenException when requester is not rider or driver', async () => {
      mockRideRepo.findOne.mockResolvedValue(baseRide);
      await expect(service.getRide('ride-1', 'tenant-1', 'stranger')).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when ride does not exist', async () => {
      mockRideRepo.findOne.mockResolvedValue(null);
      await expect(service.getRide('bad-id', 'tenant-1', 'rider-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('cancelRide', () => {
    it('cancels a ride in REQUESTED status', async () => {
      const ride = { ...baseRide, status: RideStatus.REQUESTED };
      mockRideRepo.findOne.mockResolvedValue(ride);
      mockRideRepo.save.mockImplementation((r: RideEntity) => Promise.resolve(r));

      const result = await service.cancelRide('ride-1', 'tenant-1', 'rider-1', 'No longer needed');

      expect(result.status).toBe(RideStatus.CANCELLED);
      expect(result.cancellationReason).toBe('No longer needed');
    });

    it('cancels a ride in MATCHING status', async () => {
      const ride = { ...baseRide, status: RideStatus.MATCHING };
      mockRideRepo.findOne.mockResolvedValue(ride);
      mockRideRepo.save.mockImplementation((r: RideEntity) => Promise.resolve(r));

      const result = await service.cancelRide('ride-1', 'tenant-1', 'rider-1', 'Changed mind');
      expect(result.status).toBe(RideStatus.CANCELLED);
    });

    it('throws BadRequestException when ride is DRIVER_ASSIGNED or later', async () => {
      const ride = { ...baseRide, status: RideStatus.DRIVER_ASSIGNED };
      mockRideRepo.findOne.mockResolvedValue(ride);

      await expect(
        service.cancelRide('ride-1', 'tenant-1', 'rider-1', 'Too late'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ForbiddenException when wrong rider tries to cancel', async () => {
      mockRideRepo.findOne.mockResolvedValue(baseRide);
      await expect(
        service.cancelRide('ride-1', 'tenant-1', 'other-rider', 'reason'),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
