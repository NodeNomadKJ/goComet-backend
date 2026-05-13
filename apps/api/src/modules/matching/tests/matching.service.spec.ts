import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MatchingService } from '../matching.service';
import { RideEntity } from '../../rides/entities/ride.entity';
import { RealtimeService } from '../../realtime/realtime.service';
import { TripService } from '../../trips/trip.service';
import { KafkaProducerService } from '../../kafka/kafka-producer.service';
import { REDIS_CLIENT } from '@gocomet/redis';
import { DriverStatus, RideStatus } from '@gocomet/common';

const rideId = 'ride-1';
const tenantId = 'tenant-1';
const regionId = 'region-1';
const riderId = 'rider-1';
const driverId = 'driver-a';

const mockRideRepo = { update: jest.fn() };
const mockRealtime = { emitRideOffer: jest.fn(), emitToRider: jest.fn(), emitRideStatus: jest.fn() };
const mockTrip = { createTrip: jest.fn().mockResolvedValue({ id: 'trip-1' }) };
const mockKafka = { emit: jest.fn().mockResolvedValue(undefined) };

const makeRedis = (geoResults: Array<[string, string]>, statusData: Record<string, string>) => ({
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  call: jest.fn().mockResolvedValue(geoResults),
  hgetall: jest.fn().mockResolvedValue(statusData),
  hset: jest.fn().mockResolvedValue(1),
  duplicate: jest.fn().mockReturnValue({
    subscribe: jest.fn().mockImplementation((_ch: string, cb: (err: null) => void) => cb(null)),
    on: jest.fn().mockImplementation((_ev: string, handler: (_ch: string, msg: string) => void) => {
      setTimeout(() => handler('', 'accepted'), 10);
    }),
    unsubscribe: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
  }),
});

describe('MatchingService', () => {
  let service: MatchingService;

  const buildService = async (redis: ReturnType<typeof makeRedis>) => {
    const module = await Test.createTestingModule({
      providers: [
        MatchingService,
        { provide: getRepositoryToken(RideEntity), useValue: mockRideRepo },
        { provide: RealtimeService, useValue: mockRealtime },
        { provide: TripService, useValue: mockTrip },
        { provide: KafkaProducerService, useValue: mockKafka },
        { provide: REDIS_CLIENT, useValue: redis },
      ],
    }).compile();
    return module.get(MatchingService);
  };

  afterEach(() => jest.clearAllMocks());

  it('acquires a matching lock and creates a trip when a driver accepts', async () => {
    const redis = makeRedis(
      [[driverId, '2.5']],
      { status: DriverStatus.AVAILABLE, vehicleType: 'SEDAN', rating: '4.8' },
    );
    service = await buildService(redis);

    await service.startMatching(rideId, tenantId, regionId, riderId, 77.5, 12.9, 'SEDAN', 200, 'A', 'B', 'corr-1');

    expect(redis.set).toHaveBeenCalledWith(`matching:lock:${rideId}`, '1', 'EX', 30, 'NX');
    expect(mockTrip.createTrip).toHaveBeenCalledWith(rideId, driverId, riderId, tenantId, regionId);
    expect(mockKafka.emit).toHaveBeenCalledWith(
      'driver.assignment.created',
      expect.objectContaining({ rideId, driverId, riderId }),
      tenantId,
      regionId,
      'corr-1',
    );
  });

  it('skips matching when lock is already held', async () => {
    const redis = makeRedis([], {});
    redis.set = jest.fn().mockResolvedValue(null); // NX lock held
    service = await buildService(redis);

    await service.startMatching(rideId, tenantId, regionId, riderId, 77.5, 12.9, 'SEDAN', 200, 'A', 'B', 'corr-1');

    expect(mockRideRepo.update).not.toHaveBeenCalled();
  });

  it('marks ride FAILED and emits matching failed when no candidates', async () => {
    const redis = makeRedis([], {});
    service = await buildService(redis);

    await service.startMatching(rideId, tenantId, regionId, riderId, 77.5, 12.9, 'SEDAN', 200, 'A', 'B', 'corr-1');

    expect(mockRideRepo.update).toHaveBeenCalledWith(
      { id: rideId, tenantId },
      { status: RideStatus.FAILED },
    );
    expect(mockKafka.emit).toHaveBeenCalledWith(
      'ride.matching.failed',
      expect.objectContaining({ rideId, riderId }),
      tenantId,
      regionId,
      'corr-1',
    );
  });

  it('skips BUSY drivers during candidate filtering', async () => {
    const redis = makeRedis(
      [[driverId, '1.0']],
      { status: DriverStatus.BUSY, vehicleType: 'SEDAN', rating: '5.0' },
    );
    service = await buildService(redis);

    await service.startMatching(rideId, tenantId, regionId, riderId, 77.5, 12.9, 'SEDAN', 200, 'A', 'B', 'corr-1');

    expect(mockTrip.createTrip).not.toHaveBeenCalled();
    expect(mockRideRepo.update).toHaveBeenCalledWith(
      { id: rideId, tenantId },
      { status: RideStatus.FAILED },
    );
  });

  it('skips drivers with wrong vehicle type', async () => {
    const redis = makeRedis(
      [[driverId, '1.0']],
      { status: DriverStatus.AVAILABLE, vehicleType: 'SUV', rating: '5.0' },
    );
    service = await buildService(redis);

    await service.startMatching(rideId, tenantId, regionId, riderId, 'SEDAN', 12.9, 77.5, 200, 'A', 'B', 'corr-1');

    expect(mockTrip.createTrip).not.toHaveBeenCalled();
  });
});
