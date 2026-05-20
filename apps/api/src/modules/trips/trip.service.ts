import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager, DataSource } from 'typeorm';
import { TripStatus, PaymentStatus, RideStatus, KAFKA_TOPICS, DriverStatus } from '@gocomet/common';
import { TripEntity, TripEventEntity } from '@gocomet/database';
import { RideEntity } from '../rides/entities/ride.entity';
import { PaymentEntity } from '../payments/entities/payment.entity';
import { RealtimeService } from '../realtime/realtime.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import {
  TripNotFoundException,
  InvalidTripTransitionException,
  TripAccessDeniedException,
} from './exceptions/trip.exceptions';

const ACTIVE_STATUSES = [
  TripStatus.DRIVER_ASSIGNED,
  TripStatus.DRIVER_ARRIVING,
  TripStatus.DRIVER_ARRIVED,
  TripStatus.RIDE_STARTED,
];

const CANCELLABLE_STATUSES = new Set<TripStatus>([
  TripStatus.DRIVER_ASSIGNED,
  TripStatus.DRIVER_ARRIVING,
  TripStatus.DRIVER_ARRIVED,
  TripStatus.RIDE_STARTED,
]);

@Injectable()
export class TripService {
  private readonly logger = new Logger(TripService.name);

  constructor(
    @InjectRepository(TripEntity) private readonly tripRepo: Repository<TripEntity>,
    @InjectRepository(RideEntity) private readonly rideRepo: Repository<RideEntity>,
    private readonly dataSource: DataSource,
    private readonly realtimeService: RealtimeService,
    private readonly kafkaProducer: KafkaProducerService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async createTrip(
    rideId: string,
    driverId: string,
    riderId: string,
    tenantId: string,
    regionId: string,
  ): Promise<TripEntity> {
    const trip = await this.dataSource.transaction(async (em) => {
      const entity = em.create(TripEntity, {
        rideId,
        driverId,
        riderId,
        tenantId,
        regionId,
        status: TripStatus.DRIVER_ASSIGNED,
        startedAt: null,
        completedAt: null,
        durationSecs: null,
        distanceKm: null,
        finalFare: null,
        cancellationReason: null,
        cancellationFee: null,
        paymentStatus: PaymentStatus.PENDING,
      });
      const saved = await em.save(TripEntity, entity);

      const event = em.create(TripEventEntity, {
        tripId: saved.id,
        tenantId,
        regionId,
        fromStatus: null,
        toStatus: TripStatus.DRIVER_ASSIGNED,
        actorId: driverId,
        actorRole: 'SYSTEM',
        metadata: {},
      });
      await em.save(TripEventEntity, event);

      return saved;
    });

    await Promise.all([
      this.kafkaProducer.emit(
        KAFKA_TOPICS.TRIP_STATUS_CHANGED,
        { tripId: trip.id, rideId, fromStatus: null, toStatus: TripStatus.DRIVER_ASSIGNED, driverId, riderId },
        tenantId,
        trip.regionId,
        rideId,
      ),
      this.kafkaProducer.emit(
        KAFKA_TOPICS.NOTIFICATION_PUSH_REQUESTED,
        { userId: riderId, type: 'RIDE_DRIVER_ASSIGNED', title: 'Driver Assigned', body: 'Your driver is on the way' },
        tenantId,
        trip.regionId,
      ),
    ]);

    return trip;
  }

  async markArriving(tripId: string, tenantId: string, driverId: string): Promise<TripEntity> {
    const trip = await this.loadAndAuthorizeDriver(tripId, tenantId, driverId);

    const updated = await this.dataSource.transaction(async (em) => {
      await em.update(RideEntity, { id: trip.rideId, tenantId }, { status: RideStatus.DRIVER_ARRIVING });
      return this.transition(
        trip,
        TripStatus.DRIVER_ASSIGNED,
        TripStatus.DRIVER_ARRIVING,
        trip.driverId,
        'DRIVER',
        {},
        em,
      );
    });

    await Promise.all([
      this.kafkaProducer.emit(
        KAFKA_TOPICS.TRIP_STATUS_CHANGED,
        { tripId, rideId: trip.rideId, fromStatus: TripStatus.DRIVER_ASSIGNED, toStatus: TripStatus.DRIVER_ARRIVING },
        tenantId,
        trip.regionId,
        trip.rideId,
      ),
      this.kafkaProducer.emit(
        KAFKA_TOPICS.NOTIFICATION_PUSH_REQUESTED,
        { userId: trip.riderId, type: 'DRIVER_ARRIVING', title: 'Driver On the Way', body: 'Your driver is heading to your location' },
        tenantId,
        trip.regionId,
      ),
    ]);

    this.realtimeService.emitRideStatus(trip.rideId, { rideId: trip.rideId, status: RideStatus.DRIVER_ARRIVING });

    return updated;
  }

  async markArrived(tripId: string, tenantId: string, driverId: string): Promise<TripEntity> {
    const trip = await this.loadAndAuthorizeDriver(tripId, tenantId, driverId);

    const updated = await this.dataSource.transaction(async (em) => {
      await em.update(RideEntity, { id: trip.rideId, tenantId }, { status: RideStatus.DRIVER_ARRIVED });
      return this.transition(
        trip,
        TripStatus.DRIVER_ARRIVING,
        TripStatus.DRIVER_ARRIVED,
        trip.driverId,
        'DRIVER',
        {},
        em,
      );
    });

    await Promise.all([
      this.kafkaProducer.emit(
        KAFKA_TOPICS.TRIP_STATUS_CHANGED,
        { tripId, rideId: trip.rideId, fromStatus: TripStatus.DRIVER_ARRIVING, toStatus: TripStatus.DRIVER_ARRIVED },
        tenantId,
        trip.regionId,
        trip.rideId,
      ),
      this.kafkaProducer.emit(
        KAFKA_TOPICS.NOTIFICATION_PUSH_REQUESTED,
        { userId: trip.riderId, type: 'DRIVER_ARRIVED', title: 'Driver Arrived', body: 'Your driver has arrived at the pickup point' },
        tenantId,
        trip.regionId,
      ),
    ]);

    this.realtimeService.emitRideStatus(trip.rideId, { rideId: trip.rideId, status: RideStatus.DRIVER_ARRIVED });

    return updated;
  }

  async startRide(tripId: string, tenantId: string, driverId: string): Promise<TripEntity> {
    const trip = await this.loadAndAuthorizeDriver(tripId, tenantId, driverId);
    const startedAt = new Date();

    const updated = await this.dataSource.transaction(async (em) => {
      await em.update(RideEntity, { id: trip.rideId, tenantId }, { status: RideStatus.RIDE_STARTED });
      return this.transition(
        trip,
        TripStatus.DRIVER_ARRIVED,
        TripStatus.RIDE_STARTED,
        trip.driverId,
        'DRIVER',
        { startedAt },
        em,
      );
    });

    await Promise.all([
      this.kafkaProducer.emit(
        KAFKA_TOPICS.TRIP_STATUS_CHANGED,
        { tripId, rideId: trip.rideId, fromStatus: TripStatus.DRIVER_ARRIVED, toStatus: TripStatus.RIDE_STARTED },
        tenantId,
        trip.regionId,
        trip.rideId,
      ),
      this.kafkaProducer.emit(
        KAFKA_TOPICS.NOTIFICATION_PUSH_REQUESTED,
        { userId: trip.riderId, type: 'RIDE_STARTED', title: 'Ride Started', body: 'Your ride has begun. Enjoy the trip!' },
        tenantId,
        trip.regionId,
      ),
    ]);

    this.realtimeService.emitRideStatus(trip.rideId, { rideId: trip.rideId, status: RideStatus.RIDE_STARTED });

    return updated;
  }

  async completeRide(
    tripId: string,
    tenantId: string,
    driverId: string,
    distanceKm?: number,
  ): Promise<TripEntity> {
    const trip = await this.loadAndAuthorizeDriver(tripId, tenantId, driverId);

    const ride = await this.rideRepo.findOne({ where: { id: trip.rideId, tenantId } });
    if (!ride) {
      throw new TripNotFoundException(trip.rideId);
    }

    const completedAt = new Date();
    const startedAt = trip.startedAt ?? completedAt;
    const durationSecs = Math.floor((completedAt.getTime() - startedAt.getTime()) / 1000);
    const resolvedDistanceKm = distanceKm ?? 0;
    const finalFare = Number(ride.fareEstimate);

    const updated = await this.dataSource.transaction(async (em) => {
      await em.update(RideEntity, { id: trip.rideId, tenantId }, { status: RideStatus.COMPLETED });
      const completed = await this.transition(
        trip,
        TripStatus.RIDE_STARTED,
        TripStatus.COMPLETED,
        trip.driverId,
        'DRIVER',
        { completedAt, durationSecs, distanceKm: resolvedDistanceKm, finalFare, paymentStatus: PaymentStatus.PENDING },
        em,
      );

      const payment = em.create(PaymentEntity, {
        tripId,
        riderId: trip.riderId,
        tenantId,
        regionId: trip.regionId,
        amount: finalFare,
        currency: 'INR',
        status: PaymentStatus.PENDING,
        idempotencyKey: tripId,
      });
      await em.save(PaymentEntity, payment);

      return completed;
    });

    await Promise.all([
      this.kafkaProducer.emit(
        KAFKA_TOPICS.TRIP_COMPLETED,
        { tripId, rideId: trip.rideId, riderId: trip.riderId, driverId, finalFare, distanceKm: resolvedDistanceKm, durationSecs },
        tenantId,
        trip.regionId,
        trip.rideId,
      ),
      this.kafkaProducer.emit(
        KAFKA_TOPICS.PAYMENT_CHARGE_REQUESTED,
        { tripId, riderId: trip.riderId, amount: finalFare, currency: 'INR', tenantId, regionId: trip.regionId },
        tenantId,
        trip.regionId,
        trip.rideId,
      ),
      this.kafkaProducer.emit(
        KAFKA_TOPICS.NOTIFICATION_PUSH_REQUESTED,
        { userId: trip.riderId, type: 'RIDE_COMPLETED', title: 'Ride Completed', body: `Your ride is complete. Total fare: ₹${finalFare}` },
        tenantId,
        trip.regionId,
      ),
    ]);

    this.realtimeService.emitRideStatus(trip.rideId, { rideId: trip.rideId, status: RideStatus.COMPLETED });
    this.realtimeService.emitToRider(trip.riderId, 'ride:completed', { tripId, finalFare, distanceKm: resolvedDistanceKm, durationSecs });

    return updated;
  }

  async cancelTrip(
    tripId: string,
    tenantId: string,
    actorId: string,
    actorRole: 'DRIVER' | 'RIDER',
    reason?: string,
  ): Promise<TripEntity> {
    const trip = await this.tripRepo.findOne({ where: { id: tripId, tenantId, isDeleted: false } });
    if (!trip) throw new TripNotFoundException(tripId);

    if (actorRole === 'DRIVER') {
      const driverEntityId = await this.resolveDriverEntityId(actorId, tenantId);
      if (trip.driverId !== driverEntityId) throw new TripAccessDeniedException();
    }
    if (actorRole === 'RIDER' && trip.riderId !== actorId) {
      throw new TripAccessDeniedException();
    }

    if (!CANCELLABLE_STATUSES.has(trip.status)) {
      throw new InvalidTripTransitionException(trip.status, TripStatus.CANCELLED);
    }

    const earlyStatuses = new Set<TripStatus>([TripStatus.DRIVER_ASSIGNED, TripStatus.DRIVER_ARRIVING]);
    const cancellationFee = earlyStatuses.has(trip.status) ? 0 : 50;
    const resolvedActorId = actorRole === 'DRIVER' ? trip.driverId : actorId;

    const updated = await this.dataSource.transaction(async (em) => {
      await em.update(RideEntity, { id: trip.rideId, tenantId }, { status: RideStatus.CANCELLED, cancellationReason: reason ?? null });
      return this.transition(
        trip,
        trip.status,
        TripStatus.CANCELLED,
        resolvedActorId,
        actorRole,
        { cancellationReason: reason ?? null, cancellationFee },
        em,
      );
    });

    await Promise.all([
      this.kafkaProducer.emit(
        KAFKA_TOPICS.TRIP_STATUS_CHANGED,
        { tripId, rideId: trip.rideId, fromStatus: trip.status, toStatus: TripStatus.CANCELLED, actorId: resolvedActorId, actorRole, reason, cancellationFee },
        tenantId,
        trip.regionId,
        trip.rideId,
      ),
      this.kafkaProducer.emit(
        KAFKA_TOPICS.NOTIFICATION_PUSH_REQUESTED,
        {
          userId: actorRole === 'DRIVER' ? trip.riderId : trip.driverId,
          type: 'RIDE_CANCELLED',
          title: 'Ride Cancelled',
          body: reason ? `Ride cancelled: ${reason}` : 'Your ride has been cancelled',
        },
        tenantId,
        trip.regionId,
      ),
    ]);

    await Promise.all([
      this.redis.hset(`driver:status:${trip.driverId}`, 'status', DriverStatus.AVAILABLE),
      this.redis.del(`driver:active-ride:${trip.driverId}`),
    ]);

    this.realtimeService.emitRideStatus(trip.rideId, { rideId: trip.rideId, status: RideStatus.CANCELLED });
    this.realtimeService.emitToDriver(trip.driverId, 'trip:cancelled', { tripId, rideId: trip.rideId });

    return updated;
  }

  async getTrip(tripId: string, tenantId: string, requesterId: string): Promise<TripEntity> {
    const trip = await this.tripRepo.findOne({ where: { id: tripId, tenantId, isDeleted: false } });
    if (!trip) throw new TripNotFoundException(tripId);

    if (trip.riderId === requesterId) return trip;

    const driverEntityId = await this.resolveDriverEntityId(requesterId, tenantId).catch(() => null);
    if (driverEntityId && trip.driverId === driverEntityId) return trip;

    throw new TripAccessDeniedException();
  }

  async getDriverActiveTrip(userId: string, tenantId: string): Promise<TripEntity | null> {
    // trips.driverId stores the driver entity ID (drivers.id), not userId.
    // Resolve via subquery — avoids importing DriverModule into TripModule.
    return this.tripRepo
      .createQueryBuilder('trip')
      .where(
        `trip."driverId" IN (
          SELECT id FROM drivers
          WHERE "userId" = :userId AND "tenantId" = :tenantId AND "isDeleted" = false
        )`,
        { userId, tenantId },
      )
      .andWhere('trip."tenantId" = :tenantId', { tenantId })
      .andWhere('trip."isDeleted" = false')
      .andWhere('trip.status IN (:...statuses)', { statuses: ACTIVE_STATUSES })
      .getOne();
  }

  async getDriverTripHistory(
    userId: string,
    tenantId: string,
    page: number,
    limit: number,
  ): Promise<{ data: TripEntity[]; total: number; page: number; limit: number }> {
    const [data, total] = await this.tripRepo
      .createQueryBuilder('trip')
      .where(
        `trip."driverId" IN (
          SELECT id FROM drivers
          WHERE "userId" = :userId AND "tenantId" = :tenantId AND "isDeleted" = false
        )`,
        { userId, tenantId },
      )
      .andWhere('trip."tenantId" = :tenantId', { tenantId })
      .andWhere('trip."isDeleted" = false')
      .andWhere('trip.status IN (:...statuses)', {
        statuses: [TripStatus.COMPLETED, TripStatus.CANCELLED],
      })
      .orderBy('trip.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    return { data, total, page, limit };
  }

  async cancelTripByRideId(rideId: string, tenantId: string, riderId: string, reason?: string): Promise<TripEntity | null> {
    const trip = await this.tripRepo.findOne({ where: { rideId, tenantId, isDeleted: false } });
    if (!trip) return null;
    return this.cancelTrip(trip.id, tenantId, riderId, 'RIDER', reason);
  }

  private async transition(
    trip: TripEntity,
    fromStatus: TripStatus,
    toStatus: TripStatus,
    actorId: string,
    actorRole: string,
    updates: Partial<TripEntity>,
    em: EntityManager,
  ): Promise<TripEntity> {
    if (trip.status !== fromStatus) {
      throw new InvalidTripTransitionException(trip.status, toStatus);
    }

    await em.update(TripEntity, { id: trip.id, tenantId: trip.tenantId }, { status: toStatus, ...updates });

    const eventEntity = em.create(TripEventEntity, {
      tripId: trip.id,
      tenantId: trip.tenantId,
      regionId: trip.regionId,
      fromStatus,
      toStatus,
      actorId,
      actorRole,
      metadata: {},
    });
    await em.save(TripEventEntity, eventEntity);

    const updated = await em.findOne(TripEntity, { where: { id: trip.id } });
    if (!updated) throw new TripNotFoundException(trip.id);

    this.logger.log(
      { tripId: trip.id, tenantId: trip.tenantId, fromStatus, toStatus, actorId, actorRole },
      'Trip state transition',
    );

    return updated;
  }

  private async loadAndAuthorizeDriver(tripId: string, tenantId: string, userId: string): Promise<TripEntity> {
    const trip = await this.tripRepo.findOne({ where: { id: tripId, tenantId, isDeleted: false } });
    if (!trip) throw new TripNotFoundException(tripId);
    const driverEntityId = await this.resolveDriverEntityId(userId, tenantId);
    if (trip.driverId !== driverEntityId) throw new TripAccessDeniedException();
    return trip;
  }

  private async resolveDriverEntityId(userId: string, tenantId: string): Promise<string> {
    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT id FROM drivers WHERE "userId" = $1 AND "tenantId" = $2 AND "isDeleted" = false LIMIT 1`,
      [userId, tenantId],
    );
    if (!rows.length) throw new TripAccessDeniedException();
    return rows[0].id;
  }
}
