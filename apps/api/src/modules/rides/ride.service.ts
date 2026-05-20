import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Not } from 'typeorm';
import { KAFKA_TOPICS, RideStatus, VehicleType } from '@gocomet/common';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import { RideEntity } from './entities/ride.entity';
import { KafkaProducerService } from '../kafka/kafka-producer.service';
import { TripService } from '../trips/trip.service';
import { RealtimeService } from '../realtime/realtime.service';
import type { CreateRideDto } from './dto/create-ride.dto';
import type { FareEstimateDto } from './dto/fare-estimate.dto';

const IDEMPOTENCY_TTL = 24 * 60 * 60; // 24 hours
const idempotencyKey = (tenantId: string, key: string) => `idempotency:rides:${tenantId}:${key}`;

// Haversine distance in km between two lat/lng points
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface FareBreakdown {
  distanceKm: number;
  basefare: number;
  distanceFare: number;
  surgeMultiplier: number;
  total: number;
  currency: string;
}

// Base fares per vehicle type (INR)
const BASE_FARE: Record<VehicleType, number> = {
  [VehicleType.ECONOMY]: 30,
  [VehicleType.PREMIUM]: 60,
  [VehicleType.XL]: 80,
  [VehicleType.AUTO]: 20,
  [VehicleType.BIKE]: 15,
  [VehicleType.ANY]: 30,
};

const RATE_PER_KM: Record<VehicleType, number> = {
  [VehicleType.ECONOMY]: 12,
  [VehicleType.PREMIUM]: 20,
  [VehicleType.XL]: 16,
  [VehicleType.AUTO]: 10,
  [VehicleType.BIKE]: 8,
  [VehicleType.ANY]: 12,
};

const PRE_ASSIGNMENT_STATUSES = new Set([RideStatus.REQUESTED, RideStatus.MATCHING]);
const CANCELLABLE_STATUSES = new Set([
  RideStatus.REQUESTED,
  RideStatus.MATCHING,
  RideStatus.DRIVER_ASSIGNED,
  RideStatus.DRIVER_ARRIVING,
  RideStatus.DRIVER_ARRIVED,
]);

@Injectable()
export class RideService {
  private readonly logger = new Logger(RideService.name);

  constructor(
    @InjectRepository(RideEntity)
    private readonly rideRepo: Repository<RideEntity>,
    @InjectRedis() private readonly redis: Redis,
    private readonly kafkaProducer: KafkaProducerService,
    private readonly tripService: TripService,
    private readonly realtimeService: RealtimeService,
  ) {}

  async estimateFare(dto: FareEstimateDto, regionId: string): Promise<FareBreakdown> {
    const type = dto.vehicleType ?? VehicleType.ECONOMY;
    const distanceKm = haversineKm(dto.pickupLat, dto.pickupLng, dto.dropLat, dto.dropLng);

    // Read surge from Redis — zero DB touch
    const surgeRaw = await this.redis.get(`surge:${regionId}:default`);
    const surgeMultiplier = surgeRaw ? parseFloat(surgeRaw) : 1.0;

    const basefare = BASE_FARE[type];
    const distanceFare = parseFloat((distanceKm * RATE_PER_KM[type]).toFixed(2));
    const total = parseFloat(((basefare + distanceFare) * surgeMultiplier).toFixed(2));

    return { distanceKm: parseFloat(distanceKm.toFixed(2)), basefare, distanceFare, surgeMultiplier, total, currency: 'INR' };
  }

  async createRide(
    riderId: string,
    tenantId: string,
    regionId: string,
    key: string,
    dto: CreateRideDto,
  ): Promise<RideEntity> {
    // Idempotency check — return cached response if same key replayed
    const cacheKey = idempotencyKey(tenantId, key);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      this.logger.log({ riderId, tenantId, key }, 'Idempotent ride replay');
      return JSON.parse(cached) as RideEntity;
    }

    const fareBreakdown = await this.estimateFare(
      { pickupLat: dto.pickupLat, pickupLng: dto.pickupLng, dropLat: dto.dropLat, dropLng: dto.dropLng, vehicleType: dto.vehicleType },
      regionId,
    );

    const ride = this.rideRepo.create({
      riderId,
      tenantId,
      regionId,
      driverId: null,
      status: RideStatus.REQUESTED,
      pickupLat: dto.pickupLat,
      pickupLng: dto.pickupLng,
      pickupAddress: dto.pickupAddress,
      dropLat: dto.dropLat,
      dropLng: dto.dropLng,
      dropAddress: dto.dropAddress,
      vehicleType: dto.vehicleType ?? VehicleType.ECONOMY,
      fareEstimate: fareBreakdown.total,
      surgeMultiplier: fareBreakdown.surgeMultiplier,
      cancellationReason: null,
      idempotencyKey: key,
    });

    const saved = await this.rideRepo.save(ride);

    // Cache response for 24h so replays get the same result
    await this.redis.set(cacheKey, JSON.stringify(saved), 'EX', IDEMPOTENCY_TTL);

    this.logger.log({ rideId: saved.id, riderId, tenantId, fare: fareBreakdown.total }, 'Ride created');
    await this.kafkaProducer.emit(
      KAFKA_TOPICS.RIDE_REQUEST_CREATED,
      {
        rideId: saved.id,
        riderId,
        regionId,
        vehicleType: saved.vehicleType,
        pickupLat: saved.pickupLat,
        pickupLng: saved.pickupLng,
        pickupAddress: saved.pickupAddress,
        dropLat: saved.dropLat,
        dropLng: saved.dropLng,
        dropAddress: saved.dropAddress,
        fareEstimate: saved.fareEstimate,
        surgeMultiplier: saved.surgeMultiplier,
      },
      tenantId,
      regionId,
      saved.id,
    );
    return saved;
  }

  async getRide(rideId: string, tenantId: string, requesterId: string): Promise<RideEntity> {
    const ride = await this.rideRepo.findOne({ where: { id: rideId, tenantId, isDeleted: false } });
    if (!ride) throw new NotFoundException(`Ride ${rideId} not found`);

    // Only the rider or assigned driver may view the ride
    if (ride.riderId !== requesterId && ride.driverId !== requesterId) {
      throw new ForbiddenException('Access denied');
    }
    return ride;
  }

  async cancelRide(rideId: string, tenantId: string, riderId: string, reason: string): Promise<RideEntity> {
    const ride = await this.rideRepo.findOne({ where: { id: rideId, tenantId, isDeleted: false } });
    if (!ride) throw new NotFoundException(`Ride ${rideId} not found`);
    if (ride.riderId !== riderId) throw new ForbiddenException('Only the rider can cancel this ride');

    if (!CANCELLABLE_STATUSES.has(ride.status)) {
      throw new BadRequestException(`Cannot cancel a ride in status ${ride.status}`);
    }

    if (!PRE_ASSIGNMENT_STATUSES.has(ride.status)) {
      // Driver already assigned — cancel via TripService which handles trip events,
      // driver notification, and ride.status sync in a single transaction.
      await this.tripService.cancelTripByRideId(rideId, tenantId, riderId, reason);
      return (await this.rideRepo.findOne({ where: { id: rideId, tenantId, isDeleted: false } }))!;
    }

    // No trip exists yet — cancel the ride directly.
    ride.status = RideStatus.CANCELLED;
    ride.cancellationReason = reason;
    const cancelled = await this.rideRepo.save(ride);

    // If matching was in progress, find any pending offer and clean it up.
    // This: (1) makes the gateway reject any late accept, (2) unblocks the
    // worker's waitForResponse immediately instead of waiting the full 10s timeout,
    // (3) dismisses the offer banner on the driver's UI.
    // Unblock the worker's waitForResponse immediately — one publish covers all candidates
    // since the lifecycle channel is per-ride, not per-driver
    await this.redis.publish(`ride:lifecycle:${rideId}`, 'cancelled');

    // Find any driver currently holding an offer UI — dismiss their banner
    const offerKeys = await this.redis.keys(`ride:offer:${rideId}:*`);
    for (const key of offerKeys) {
      const driverId = key.split(':').pop()!;
      await this.redis.del(key);
      this.realtimeService.emitToDriver(driverId, 'offer:cancelled', { rideId });
    }

    await this.kafkaProducer.emit(
      KAFKA_TOPICS.RIDE_REQUEST_CANCELLED,
      { rideId, riderId, reason },
      tenantId,
      ride.regionId,
      rideId,
    );
    return cancelled;
  }

  async getActiveRideByRider(riderId: string, tenantId: string): Promise<RideEntity | null> {
    const terminalStatuses = [RideStatus.COMPLETED, RideStatus.CANCELLED, RideStatus.FAILED];
    return this.rideRepo.findOne({
      where: { riderId, tenantId, isDeleted: false, status: Not(In(terminalStatuses)) },
      order: { createdAt: 'DESC' },
    });
  }

  async getRidesByRider(
    riderId: string,
    tenantId: string,
    page: number,
    limit: number,
  ): Promise<{ data: RideEntity[]; total: number; page: number; limit: number }> {
    const terminalStatuses = [RideStatus.COMPLETED, RideStatus.CANCELLED, RideStatus.FAILED];
    const [data, total] = await this.rideRepo.findAndCount({
      where: { riderId, tenantId, isDeleted: false, status: In(terminalStatuses) },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, limit };
  }
}
