import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { LocationService } from '../services/location.service';
import { DriverService } from '../driver.service';

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  pipeline: jest.fn(),
  geoadd: jest.fn(),
  hset: jest.fn(),
  expire: jest.fn(),
  zadd: jest.fn(),
};

const mockDriverService = {
  getProfile: jest.fn(),
};

const baseDriver = { id: 'driver-entity-1', userId: 'user-1', tenantId: 'tenant-1' };

describe('LocationService', () => {
  let service: LocationService;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Default: pipeline exec returns success results
    const mockPipeline = {
      geoadd: jest.fn().mockReturnThis(),
      hset: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      zremrangebyscore: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([
        [null, 1], // zremrangebyscore
        [null, 1], // zadd (rate)
        [null, 1], // zcard → count = 1 (within limit)
        [null, 2], // expire
      ]),
    };
    mockRedis.pipeline.mockReturnValue(mockPipeline);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocationService,
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
        { provide: DriverService, useValue: mockDriverService },
      ],
    }).compile();

    service = module.get<LocationService>(LocationService);
  });

  describe('resolveDriverEntityId', () => {
    it('returns cached entity ID without hitting DriverService', async () => {
      mockRedis.get.mockResolvedValue('driver-entity-1');

      const id = await service.resolveDriverEntityId('user-1', 'tenant-1');

      expect(id).toBe('driver-entity-1');
      expect(mockDriverService.getProfile).not.toHaveBeenCalled();
    });

    it('falls back to DB and caches result on cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.set.mockResolvedValue('OK');
      mockDriverService.getProfile.mockResolvedValue(baseDriver);

      const id = await service.resolveDriverEntityId('user-1', 'tenant-1');

      expect(mockDriverService.getProfile).toHaveBeenCalledWith('user-1', 'tenant-1');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'driver:entity:user-1:tenant-1',
        'driver-entity-1',
        'EX',
        3600,
      );
      expect(id).toBe('driver-entity-1');
    });

    it('throws NotFoundException when driver profile does not exist', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockDriverService.getProfile.mockRejectedValue(new NotFoundException('Driver profile not found'));

      await expect(service.resolveDriverEntityId('ghost', 'tenant-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateLocation', () => {
    it('writes GEOADD + HSET + EXPIRE + ZADD via pipeline', async () => {
      mockRedis.get.mockResolvedValue('driver-entity-1');

      const pipeline = mockRedis.pipeline();
      pipeline.exec.mockResolvedValue([
        [null, 1], [null, 1], [null, 1], // rate limiter (count = 1, within limit)
        [null, 2], // expire
      ]);

      await service.updateLocation('user-1', 'tenant-1', 'region-1', {
        lat: 12.9716,
        lng: 77.5946,
        heading: 90,
      });

      expect(pipeline.geoadd).toHaveBeenCalledWith(
        'drivers:geo:region-1',
        77.5946,
        12.9716,
        'driver-entity-1',
      );
      expect(pipeline.hset).toHaveBeenCalled();
      expect(pipeline.zadd).toHaveBeenCalled();
      expect(pipeline.exec).toHaveBeenCalled();
    });

    it('throws 429 when driver exceeds 2 updates/second', async () => {
      mockRedis.get.mockResolvedValue('driver-entity-1');

      const rateLimitPipeline = {
        geoadd: jest.fn().mockReturnThis(),
        hset: jest.fn().mockReturnThis(),
        expire: jest.fn().mockReturnThis(),
        zadd: jest.fn().mockReturnThis(),
        zremrangebyscore: jest.fn().mockReturnThis(),
        zcard: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([
          [null, 1], // zremrangebyscore
          [null, 3], // zadd
          [null, 3], // zcard → count = 3 (exceeds MAX_UPDATES_PER_SEC = 2)
          [null, 1], // expire
        ]),
      };
      mockRedis.pipeline.mockReturnValue(rateLimitPipeline);

      await expect(
        service.updateLocation('user-1', 'tenant-1', 'region-1', { lat: 12.9, lng: 77.5 }),
      ).rejects.toThrow(new HttpException('', HttpStatus.TOO_MANY_REQUESTS));
    });
  });
});
