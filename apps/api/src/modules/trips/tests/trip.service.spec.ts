import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TripService } from '../trip.service';
import { TripEntity, TripEventEntity } from '@gocomet/database';
import { RideEntity } from '../../rides/entities/ride.entity';
import { PaymentEntity } from '../../payments/entities/payment.entity';
import { RealtimeService } from '../../realtime/realtime.service';
import { KafkaProducerService } from '../../kafka/kafka-producer.service';
import { REDIS_CLIENT } from '@gocomet/redis';
import { TripStatus, PaymentStatus, RideStatus } from '@gocomet/common';
import {
  InvalidTripTransitionException,
  TripAccessDeniedException,
} from '../exceptions/trip.exceptions';

const TRIP_ID = 'trip-001';
const RIDE_ID = 'ride-001';
const DRIVER_ID = 'driver-001';
const RIDER_ID = 'rider-001';
const TENANT_ID = 'tenant-001';
const REGION_ID = 'region-001';

const baseTrip: Partial<TripEntity> = {
  id: TRIP_ID,
  rideId: RIDE_ID,
  driverId: DRIVER_ID,
  riderId: RIDER_ID,
  tenantId: TENANT_ID,
  regionId: REGION_ID,
  status: TripStatus.DRIVER_ASSIGNED,
  startedAt: null,
  completedAt: null,
  durationSecs: null,
  distanceKm: null,
  finalFare: null,
  cancellationReason: null,
  cancellationFee: null,
  paymentStatus: PaymentStatus.PENDING,
  isDeleted: false,
};

const baseRide: Partial<RideEntity> = {
  id: RIDE_ID,
  riderId: RIDER_ID,
  tenantId: TENANT_ID,
  regionId: REGION_ID,
  fareEstimate: 200,
};

const mockTripRepo = {
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
};

const mockTripEventRepo = {
  create: jest.fn(),
  save: jest.fn(),
};

const mockRideRepo = {
  findOne: jest.fn(),
};

const mockPaymentRepo = {
  create: jest.fn(),
  save: jest.fn(),
};

const mockEntityManager = {
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
  findOne: jest.fn(),
};

const mockDataSource = {
  transaction: jest.fn(),
};

const mockRealtimeService = {
  emitRideStatus: jest.fn(),
  emitToRider: jest.fn(),
};

const mockKafkaProducer = {
  emit: jest.fn().mockResolvedValue(undefined),
};

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
};

describe('TripService', () => {
  let service: TripService;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockDataSource.transaction.mockImplementation(
      (cb: (em: typeof mockEntityManager) => Promise<unknown>) => cb(mockEntityManager),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TripService,
        { provide: getRepositoryToken(TripEntity), useValue: mockTripRepo },
        { provide: getRepositoryToken(TripEventEntity), useValue: mockTripEventRepo },
        { provide: getRepositoryToken(RideEntity), useValue: mockRideRepo },
        { provide: getRepositoryToken(PaymentEntity), useValue: mockPaymentRepo },
        { provide: DataSource, useValue: mockDataSource },
        { provide: RealtimeService, useValue: mockRealtimeService },
        { provide: KafkaProducerService, useValue: mockKafkaProducer },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<TripService>(TripService);
  });

  describe('createTrip', () => {
    it('creates a TripEntity with DRIVER_ASSIGNED status and emits Kafka events', async () => {
      const savedTrip = { ...baseTrip } as TripEntity;
      mockEntityManager.create.mockImplementation((_entity: unknown, data: unknown) => data);
      mockEntityManager.save.mockResolvedValueOnce(savedTrip).mockResolvedValue({});

      const result = await service.createTrip(RIDE_ID, DRIVER_ID, RIDER_ID, TENANT_ID, REGION_ID);

      expect(mockEntityManager.save).toHaveBeenCalledTimes(2);
      expect(mockKafkaProducer.emit).toHaveBeenCalledWith(
        'trip.status.changed',
        expect.objectContaining({ toStatus: TripStatus.DRIVER_ASSIGNED }),
        TENANT_ID,
        expect.any(String),
      );
      expect(mockKafkaProducer.emit).toHaveBeenCalledWith(
        'notification.push.requested',
        expect.objectContaining({ userId: RIDER_ID, type: 'RIDE_DRIVER_ASSIGNED' }),
        TENANT_ID,
        expect.any(String),
      );
      expect(result).toBe(savedTrip);
    });
  });

  describe('markArriving', () => {
    it('transitions from DRIVER_ASSIGNED to DRIVER_ARRIVING on happy path', async () => {
      const trip = { ...baseTrip, status: TripStatus.DRIVER_ASSIGNED } as TripEntity;
      const updatedTrip = { ...trip, status: TripStatus.DRIVER_ARRIVING } as TripEntity;

      mockTripRepo.findOne.mockResolvedValue(trip);
      mockEntityManager.update.mockResolvedValue({});
      mockEntityManager.create.mockImplementation((_e: unknown, d: unknown) => d);
      mockEntityManager.save.mockResolvedValue({});
      mockEntityManager.findOne.mockResolvedValue(updatedTrip);

      const result = await service.markArriving(TRIP_ID, TENANT_ID, DRIVER_ID);

      expect(mockEntityManager.update).toHaveBeenCalledWith(
        TripEntity,
        { id: TRIP_ID, tenantId: TENANT_ID },
        expect.objectContaining({ status: TripStatus.DRIVER_ARRIVING }),
      );
      expect(mockRealtimeService.emitRideStatus).toHaveBeenCalledWith(
        RIDE_ID,
        { rideId: RIDE_ID, status: RideStatus.DRIVER_ARRIVING },
      );
      expect(result.status).toBe(TripStatus.DRIVER_ARRIVING);
    });

    it('throws InvalidTripTransitionException when trip is not in DRIVER_ASSIGNED status', async () => {
      const trip = { ...baseTrip, status: TripStatus.RIDE_STARTED } as TripEntity;
      mockTripRepo.findOne.mockResolvedValue(trip);

      await expect(service.markArriving(TRIP_ID, TENANT_ID, DRIVER_ID)).rejects.toThrow(
        InvalidTripTransitionException,
      );
    });
  });

  describe('completeRide', () => {
    it('transitions to COMPLETED, sets timing fields, and creates PaymentEntity', async () => {
      const startedAt = new Date(Date.now() - 60_000);
      const trip = { ...baseTrip, status: TripStatus.RIDE_STARTED, startedAt } as TripEntity;
      const completedTrip = { ...trip, status: TripStatus.COMPLETED } as TripEntity;

      mockTripRepo.findOne.mockResolvedValue(trip);
      mockRideRepo.findOne.mockResolvedValue(baseRide as RideEntity);
      mockEntityManager.update.mockResolvedValue({});
      mockEntityManager.create.mockImplementation((_e: unknown, d: unknown) => d);
      mockEntityManager.save.mockResolvedValue({});
      mockEntityManager.findOne.mockResolvedValue(completedTrip);

      const result = await service.completeRide(TRIP_ID, TENANT_ID, DRIVER_ID, 5.5);

      expect(mockEntityManager.update).toHaveBeenCalledWith(
        TripEntity,
        { id: TRIP_ID, tenantId: TENANT_ID },
        expect.objectContaining({
          status: TripStatus.COMPLETED,
          distanceKm: 5.5,
          finalFare: 200,
          paymentStatus: PaymentStatus.PENDING,
        }),
      );
      expect(mockEntityManager.save).toHaveBeenCalledWith(
        PaymentEntity,
        expect.objectContaining({ tripId: TRIP_ID, riderId: RIDER_ID, amount: 200, currency: 'INR' }),
      );
      expect(mockKafkaProducer.emit).toHaveBeenCalledWith(
        'payment.charge.requested',
        expect.objectContaining({ tripId: TRIP_ID, amount: 200 }),
        TENANT_ID,
        REGION_ID,
      );
      expect(result.status).toBe(TripStatus.COMPLETED);
    });
  });

  describe('cancelTrip', () => {
    it('cancels from DRIVER_ASSIGNED with zero cancellation fee', async () => {
      const trip = { ...baseTrip, status: TripStatus.DRIVER_ASSIGNED } as TripEntity;
      const cancelledTrip = { ...trip, status: TripStatus.CANCELLED, cancellationFee: 0 } as TripEntity;

      mockTripRepo.findOne.mockResolvedValue(trip);
      mockEntityManager.update.mockResolvedValue({});
      mockEntityManager.create.mockImplementation((_e: unknown, d: unknown) => d);
      mockEntityManager.save.mockResolvedValue({});
      mockEntityManager.findOne.mockResolvedValue(cancelledTrip);

      const result = await service.cancelTrip(TRIP_ID, TENANT_ID, DRIVER_ID, 'DRIVER', 'Changed plans');

      expect(mockEntityManager.update).toHaveBeenCalledWith(
        TripEntity,
        { id: TRIP_ID, tenantId: TENANT_ID },
        expect.objectContaining({ status: TripStatus.CANCELLED, cancellationFee: 0 }),
      );
      expect(result.status).toBe(TripStatus.CANCELLED);
    });

    it('cancels from RIDE_STARTED with non-zero cancellation fee', async () => {
      const trip = { ...baseTrip, status: TripStatus.RIDE_STARTED } as TripEntity;
      const cancelledTrip = { ...trip, status: TripStatus.CANCELLED, cancellationFee: 50 } as TripEntity;

      mockTripRepo.findOne.mockResolvedValue(trip);
      mockEntityManager.update.mockResolvedValue({});
      mockEntityManager.create.mockImplementation((_e: unknown, d: unknown) => d);
      mockEntityManager.save.mockResolvedValue({});
      mockEntityManager.findOne.mockResolvedValue(cancelledTrip);

      const result = await service.cancelTrip(TRIP_ID, TENANT_ID, RIDER_ID, 'RIDER', 'Emergency');

      expect(mockEntityManager.update).toHaveBeenCalledWith(
        TripEntity,
        { id: TRIP_ID, tenantId: TENANT_ID },
        expect.objectContaining({ status: TripStatus.CANCELLED, cancellationFee: 50 }),
      );
      expect(result.status).toBe(TripStatus.CANCELLED);
    });
  });

  describe('getTrip', () => {
    it('returns trip when requester is the driver', async () => {
      mockTripRepo.findOne.mockResolvedValue(baseTrip as TripEntity);
      const result = await service.getTrip(TRIP_ID, TENANT_ID, DRIVER_ID);
      expect(result.id).toBe(TRIP_ID);
    });

    it('returns trip when requester is the rider', async () => {
      mockTripRepo.findOne.mockResolvedValue(baseTrip as TripEntity);
      const result = await service.getTrip(TRIP_ID, TENANT_ID, RIDER_ID);
      expect(result.id).toBe(TRIP_ID);
    });

    it('throws TripAccessDeniedException for an unrelated requester', async () => {
      mockTripRepo.findOne.mockResolvedValue(baseTrip as TripEntity);
      await expect(service.getTrip(TRIP_ID, TENANT_ID, 'stranger-id')).rejects.toThrow(
        TripAccessDeniedException,
      );
    });
  });
});
