import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DriverStatus, RideStatus, VehicleType, KAFKA_TOPICS, TripStatus, PaymentStatus } from '@gocomet/common';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import { Emitter } from '@socket.io/redis-emitter';
import { TripEntity } from '@gocomet/database';
import { KafkaProducerService } from '../../kafka/kafka-producer.service';
import type { RideOfferPayload } from './interfaces/realtime-event.types';

interface DriverCandidate {
  driverId: string;
  distance: number;
  rating: number;
  vehicleType: string;
}

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);
  private readonly emitter: Emitter;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly kafkaProducer: KafkaProducerService,
  ) {
    this.emitter = new Emitter(redis);
  }

  async startMatching(
    rideId: string,
    tenantId: string,
    regionId: string,
    riderId: string,
    pickupLng: number,
    pickupLat: number,
    vehicleType: string,
    fareEstimate: number,
    pickupAddress: string,
    dropAddress: string,
    correlationId: string,
  ): Promise<void> {
    const lock = await this.redis.set(`matching:lock:${rideId}`, '1', 'EX', 30, 'NX');
    if (lock === null) {
      this.logger.warn({ rideId }, 'Matching already in progress — skipping');
      return;
    }

    try {
      await this.dataSource.query(
        `UPDATE rides SET status = $1 WHERE id = $2 AND "tenantId" = $3`,
        [RideStatus.MATCHING, rideId, tenantId],
      );

      let assigned = false;
      const declinedKey = `ride:declined:${rideId}`;

      for (const radius of [5, 10, 15]) {
        const alreadyOffered = new Set(await this.redis.smembers(declinedKey));
        const candidates = (await this.findCandidates(regionId, pickupLng, pickupLat, radius, vehicleType))
          .filter(c => !alreadyOffered.has(c.driverId));

        let rideCancelled = false;
        for (const candidate of candidates) {
          const result = await this.offerRide(
            rideId, tenantId, regionId, riderId, candidate,
            pickupLat, pickupLng, vehicleType, fareEstimate,
            pickupAddress, dropAddress, correlationId,
          );

          if (result === 'accepted') { assigned = true; break; }
          if (result === 'cancelled') { rideCancelled = true; break; }

          await this.redis.sadd(declinedKey, candidate.driverId);
          await this.redis.expire(declinedKey, 1800);
        }

        if (assigned || rideCancelled) break;
      }

      if (!assigned) {
        const { rowCount } = await this.dataSource.query(
          `UPDATE rides SET status = $1 WHERE id = $2 AND "tenantId" = $3 AND status = $4`,
          [RideStatus.FAILED, rideId, tenantId, RideStatus.MATCHING],
        );
        if (rowCount === 0) return; // rider cancelled during matching — ride already CANCELLED
        await this.kafkaProducer.emit(KAFKA_TOPICS.RIDE_MATCHING_FAILED, { rideId, riderId }, tenantId, regionId, correlationId);
        this.emitter.of('/rider').to(`user:${riderId}`).emit('ride:status', { rideId, status: RideStatus.FAILED });
      }
    } finally {
      await this.redis.del(`matching:lock:${rideId}`);
      await this.redis.del(`ride:declined:${rideId}`);
    }
  }

  private async findCandidates(
    regionId: string,
    lng: number,
    lat: number,
    radiusKm: number,
    vehicleType: string,
  ): Promise<DriverCandidate[]> {
    const results = (await this.redis.call(
      'GEOSEARCH',
      `drivers:geo:${regionId}`,
      'FROMLONLAT', String(lng), String(lat),
      'BYRADIUS', String(radiusKm), 'km',
      'ASC',
      'COUNT', '10',
      'WITHDIST',
    )) as Array<[string, string]>;

    const candidates: DriverCandidate[] = [];

    for (const [driverId, distStr] of results) {
      const statusData = await this.redis.hgetall(`driver:status:${driverId}`);

      if (!statusData || statusData['status'] !== DriverStatus.AVAILABLE) continue;
      if (vehicleType !== 'ANY' && statusData['vehicleType'] !== vehicleType) continue;

      candidates.push({
        driverId,
        distance: parseFloat(distStr),
        rating: parseFloat(statusData['rating'] ?? '5'),
        vehicleType: statusData['vehicleType'] ?? '',
      });
    }

    candidates.sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      return a.distance - b.distance;
    });

    return candidates.slice(0, 5);
  }

  private async offerRide(
    rideId: string,
    tenantId: string,
    regionId: string,
    riderId: string,
    candidate: DriverCandidate,
    pickupLat: number,
    pickupLng: number,
    vehicleType: string,
    fareEstimate: number,
    pickupAddress: string,
    dropAddress: string,
    correlationId: string,
  ): Promise<'accepted' | 'declined' | 'timeout' | 'cancelled'> {
    await this.redis.set(
      `ride:offer:${rideId}:${candidate.driverId}`,
      JSON.stringify({ offeredAt: Date.now(), riderId }),
      'EX', 10,
    );

    const offerPayload: RideOfferPayload = {
      rideId,
      riderId,
      pickupLat,
      pickupLng,
      pickupAddress,
      dropAddress,
      fareEstimate,
      vehicleType: vehicleType as VehicleType,
      expiresAt: Date.now() + 10000,
    };

    this.emitter.of('/driver').to(`driver:${candidate.driverId}`).emit('ride:offer', offerPayload);

    const result = await this.waitForResponse(
      `offer:response:${rideId}:${candidate.driverId}`,
      `ride:lifecycle:${rideId}`,
      10000,
    );

    if (result === 'accepted') {
      // One DB transaction: ride status + trip insert — no consistency window
      const trip = await this.dataSource.transaction(async (em) => {
        await em.query(
          `UPDATE rides SET status = $1, "driverId" = $2 WHERE id = $3 AND "tenantId" = $4`,
          [RideStatus.DRIVER_ASSIGNED, candidate.driverId, rideId, tenantId],
        );
        const entity = em.create(TripEntity, {
          rideId,
          driverId: candidate.driverId,
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
        return em.save(TripEntity, entity);
      });

      // Redis state — tight sequence before any other matching sees this driver
      await this.redis.hset(`driver:status:${candidate.driverId}`, 'status', DriverStatus.BUSY);
      await this.redis.set(`driver:active-ride:${candidate.driverId}`, rideId, 'EX', 14400);
      await this.redis.hset(`ride:active:${rideId}`, {
        status: RideStatus.DRIVER_ASSIGNED,
        driverId: candidate.driverId,
        riderId,
      });

      await this.kafkaProducer.emit(
        KAFKA_TOPICS.DRIVER_ASSIGNMENT_CREATED,
        { rideId, driverId: candidate.driverId, riderId, tripId: trip.id },
        tenantId, regionId, correlationId,
      );
      this.emitter.of('/rider').to(`user:${riderId}`).emit('ride:status', {
        rideId, status: RideStatus.DRIVER_ASSIGNED, driverId: candidate.driverId,
      });
      this.emitter.of('/driver').to(`driver:${candidate.driverId}`).emit('trip:assigned', trip);
    }

    await this.redis.del(`ride:offer:${rideId}:${candidate.driverId}`);

    return result;
  }

  private waitForResponse(responseChannel: string, lifecycleChannel: string, timeoutMs: number): Promise<'accepted' | 'declined' | 'timeout' | 'cancelled'> {
    return new Promise((resolve) => {
      const subscriber = this.redis.duplicate();
      let settled = false;

      const cleanup = (result: 'accepted' | 'declined' | 'timeout' | 'cancelled') => {
        if (settled) return;
        settled = true;
        subscriber.unsubscribe().finally(() => subscriber.disconnect());
        resolve(result);
      };

      const timer = setTimeout(() => cleanup('timeout'), timeoutMs);

      subscriber.subscribe(responseChannel, lifecycleChannel, (err) => {
        if (err) {
          clearTimeout(timer);
          cleanup('timeout');
        }
      });

      subscriber.on('message', (ch: string, message: string) => {
        clearTimeout(timer);
        if (ch === lifecycleChannel && message === 'cancelled') {
          cleanup('cancelled');
          return;
        }
        cleanup(message === 'accepted' ? 'accepted' : 'declined');
      });
    });
  }
}
