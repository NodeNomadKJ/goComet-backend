import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DriverStatus, RideStatus, VehicleType, KAFKA_TOPICS } from '@gocomet/common';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import { RideEntity } from '../rides/entities/ride.entity';
import { RealtimeService } from '../realtime/realtime.service';
import { TripService } from '../trips/trip.service';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import type { RideOfferPayload } from '../realtime/events/realtime-event.types';

interface DriverCandidate {
  driverId: string;
  distance: number;
  rating: number;
  vehicleType: string;
}

@Injectable()
export class MatchingService {
  private readonly logger = new Logger(MatchingService.name);

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectRepository(RideEntity) private readonly rideRepo: Repository<RideEntity>,
    private readonly realtimeService: RealtimeService,
    private readonly tripService: TripService,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

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
      await this.rideRepo.update({ id: rideId, tenantId }, { status: RideStatus.MATCHING });

      let assigned = false;
      const declinedKey = `ride:declined:${rideId}`;

      for (const radius of [5, 10, 15]) {
        // Exclude drivers already offered this ride (declined or timed out on earlier pass)
        const alreadyOffered = new Set(await this.redis.smembers(declinedKey));
        const candidates = (await this.findCandidates(regionId, pickupLng, pickupLat, radius, vehicleType))
          .filter(c => !alreadyOffered.has(c.driverId));

        for (const candidate of candidates) {
          const result = await this.offerRide(
            rideId, tenantId, regionId, riderId, candidate,
            pickupLat, pickupLng, vehicleType, fareEstimate,
            pickupAddress, dropAddress, correlationId,
          );

          if (result === 'accepted') {
            assigned = true;
            break;
          }

          // Track offered-but-not-accepted drivers so wider radius passes skip them
          await this.redis.sadd(declinedKey, candidate.driverId);
          await this.redis.expire(declinedKey, 1800);
        }

        if (assigned) break;
      }

      if (!assigned) {
        await this.rideRepo.update({ id: rideId, tenantId }, { status: RideStatus.FAILED });
        await this.kafkaProducer.emit(KAFKA_TOPICS.RIDE_MATCHING_FAILED, { rideId, riderId }, tenantId, regionId, correlationId);
        this.realtimeService.emitToRider(riderId, 'ride:status', { rideId, status: RideStatus.FAILED });
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
  ): Promise<'accepted' | 'declined' | 'timeout'> {
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

    this.realtimeService.emitRideOffer(candidate.driverId, offerPayload);

    const result = await this.waitForResponse(`offer:response:${rideId}:${candidate.driverId}`, 10000);

    if (result === 'accepted') {
      await this.rideRepo.update(
        { id: rideId, tenantId },
        { driverId: candidate.driverId, status: RideStatus.DRIVER_ASSIGNED },
      );
      await this.redis.hset(`driver:status:${candidate.driverId}`, 'status', DriverStatus.BUSY);
      await this.redis.set(`driver:active-ride:${candidate.driverId}`, rideId, 'EX', 14400);
      await this.redis.hset(`ride:active:${rideId}`, {
        status: RideStatus.DRIVER_ASSIGNED,
        driverId: candidate.driverId,
        riderId,
      });
      const trip = await this.tripService.createTrip(rideId, candidate.driverId, riderId, tenantId, regionId);
      await this.kafkaProducer.emit(
        KAFKA_TOPICS.DRIVER_ASSIGNMENT_CREATED,
        { rideId, driverId: candidate.driverId, riderId },
        tenantId,
        regionId,
        correlationId,
      );
      this.realtimeService.emitToRider(riderId, 'ride:status', {
        rideId,
        status: RideStatus.DRIVER_ASSIGNED,
        driverId: candidate.driverId,
      });
      // Push trip data directly to the driver — avoids race where frontend
      // queries DB before the trip row is committed.
      this.realtimeService.emitToDriver(candidate.driverId, 'trip:assigned', trip);
    }

    await this.redis.del(`ride:offer:${rideId}:${candidate.driverId}`);

    return result;
  }

  private waitForResponse(channel: string, timeoutMs: number): Promise<'accepted' | 'declined' | 'timeout'> {
    return new Promise((resolve) => {
      const subscriber = this.redis.duplicate();
      let settled = false;

      const cleanup = (result: 'accepted' | 'declined' | 'timeout') => {
        if (settled) return;
        settled = true;
        subscriber.unsubscribe().finally(() => subscriber.disconnect());
        resolve(result);
      };

      const timer = setTimeout(() => cleanup('timeout'), timeoutMs);

      subscriber.subscribe(channel, (err) => {
        if (err) {
          clearTimeout(timer);
          cleanup('timeout');
        }
      });

      subscriber.on('message', (_ch: string, message: string) => {
        clearTimeout(timer);
        cleanup(message === 'accepted' ? 'accepted' : 'declined');
      });
    });
  }
}
