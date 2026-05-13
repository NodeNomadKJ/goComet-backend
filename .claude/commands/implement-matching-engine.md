# /implement-matching-engine

Implement the driver matching engine. This is the most complex module.
Prerequisite: Phase 2 complete (Redis GEO + Socket.IO live).

## Architecture

```
ride.request.created (Kafka)
        ↓
  MatchingConsumer
        ↓
  1. Acquire distributed lock: matching:lock:{rideId} SET NX TTL 30s
  2. GEORADIUS drivers:geo:{regionId} {lng} {lat} 5km
  3. Filter: check driver:status:{id} = AVAILABLE
  4. Rank candidates: ETA + rating + acceptance rate + vehicle tier
  5. Send offer to top candidate via Socket.IO
  6. Set offer TTL: ride:offer:{rideId}:{driverId} EX 6s
  7. Wait for response (Redis pub/sub or callback)
  8. If accept → assign, if decline/timeout → next candidate
  9. If all exhausted → expand radius → repeat
  10. If no match → emit ride.matching.failed
```

## What to Build

### File Structure

```
apps/worker/src/modules/matching/
  matching.module.ts
  matching.consumer.ts       ← Kafka consumer entry
  matching.service.ts        ← core matching logic
  candidate.service.ts       ← ranking + filtering
  offer.service.ts           ← offer send/receive/timeout
  dto/
    matching-context.dto.ts
  interfaces/
    candidate.interface.ts
    offer.interface.ts
  tests/
    matching.service.spec.ts
    candidate.service.spec.ts
    offer.service.spec.ts
```

### Candidate Interface

```typescript
interface DriverCandidate {
  driverId: string;
  tenantId: string;
  regionId: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  vehicleType: VehicleType;
  rating: number;           // 0.0–5.0
  acceptanceRate: number;   // 0–100
  etaMinutes: number;       // estimated pickup ETA
  score: number;            // computed ranking score
}
```

### CandidateService — Ranking Algorithm

```typescript
@Injectable()
export class CandidateService {

  async findCandidates(
    regionId: string,
    tenantId: string,
    pickupLat: number,
    pickupLng: number,
    vehicleType: VehicleType,
    radiusKm: number,
  ): Promise<DriverCandidate[]> {
    // 1. Redis GEORADIUS — returns [driverId, distance] sorted by distance
    const geoResults = await this.redis.georadius(
      `drivers:geo:${regionId}`,
      pickupLng, pickupLat,
      radiusKm, 'km',
      'WITHCOORD', 'WITHDIST', 'COUNT', 20, 'ASC',
    );

    if (!geoResults?.length) return [];

    // 2. Batch fetch driver status from Redis
    const pipeline = this.redis.pipeline();
    for (const [driverId] of geoResults) {
      pipeline.hgetall(`driver:status:${driverId}`);
    }
    const statusResults = await pipeline.exec();

    // 3. Filter: available + correct vehicle type + tenant matches
    const candidates: DriverCandidate[] = [];
    for (let i = 0; i < geoResults.length; i++) {
      const [driverId, distStr, coords] = geoResults[i] as [string, string, [string, string]];
      const status = statusResults[i][1] as Record<string, string>;

      if (!status || status.status !== 'AVAILABLE') continue;
      if (status.vehicleType !== vehicleType && vehicleType !== VehicleType.ANY) continue;
      if (status.tenantId !== tenantId) continue;

      const distanceMeters = parseFloat(distStr) * 1000;
      const etaMinutes = this.estimateETA(distanceMeters);
      const rating = parseFloat(status.rating || '5.0');
      const acceptanceRate = parseFloat(status.acceptanceRate || '100');

      candidates.push({
        driverId,
        tenantId,
        regionId,
        lat: parseFloat(coords[1]),
        lng: parseFloat(coords[0]),
        distanceMeters,
        vehicleType: status.vehicleType as VehicleType,
        rating,
        acceptanceRate,
        etaMinutes,
        score: 0,
      });
    }

    // 4. Rank candidates
    return this.rankCandidates(candidates);
  }

  private rankCandidates(candidates: DriverCandidate[]): DriverCandidate[] {
    for (const c of candidates) {
      // Scoring weights (tunable per tenant in Phase 5):
      // - ETA: lower = better (max 40 points)
      // - Rating: higher = better (max 30 points)
      // - Acceptance rate: higher = better (max 20 points)
      // - Distance: closer = better (max 10 points)
      const etaScore = Math.max(0, 40 - c.etaMinutes * 4);
      const ratingScore = (c.rating / 5) * 30;
      const acceptanceScore = (c.acceptanceRate / 100) * 20;
      const distanceScore = Math.max(0, 10 - c.distanceMeters / 500);
      c.score = etaScore + ratingScore + acceptanceScore + distanceScore;
    }
    return candidates.sort((a, b) => b.score - a.score);
  }

  private estimateETA(distanceMeters: number): number {
    // Assume 25 km/h in city traffic
    return Math.ceil((distanceMeters / 1000 / 25) * 60);
  }
}
```

### OfferService — Offer Flow with Timeout

```typescript
@Injectable()
export class OfferService {
  private readonly OFFER_TTL_SECONDS = 6;

  async sendOffer(rideId: string, candidate: DriverCandidate, rideDetails: RideDetails): Promise<boolean> {
    const offerKey = `ride:offer:${rideId}:${candidate.driverId}`;

    // Store offer in Redis (prevents double-offer, enables validation)
    await this.redis.set(offerKey, JSON.stringify({
      offeredAt: Date.now(),
      rideId,
      candidateScore: candidate.score,
    }), 'EX', this.OFFER_TTL_SECONDS + 2);

    // Send offer via Socket.IO
    this.realtimeService.sendDriverOffer(candidate.driverId, {
      rideId,
      pickupLat: rideDetails.pickupLat,
      pickupLng: rideDetails.pickupLng,
      pickupAddress: rideDetails.pickupAddress,
      dropAddress: rideDetails.dropAddress,
      fareEstimate: rideDetails.fareEstimate,
      etaMinutes: candidate.etaMinutes,
      distanceMeters: candidate.distanceMeters,
      expiresAt: Date.now() + this.OFFER_TTL_SECONDS * 1000,
    });

    // Wait for response via Redis pub/sub with timeout
    const accepted = await this.waitForOfferResponse(rideId, candidate.driverId);
    return accepted;
  }

  private waitForOfferResponse(rideId: string, driverId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const responseKey = `offer:response:${rideId}:${driverId}`;
      const timeout = setTimeout(() => {
        this.redis.unsubscribe(responseKey);
        resolve(false);  // timeout = decline
      }, this.OFFER_TTL_SECONDS * 1000);

      // Subscribe to driver's response channel
      this.redisSub.subscribe(responseKey, (message) => {
        clearTimeout(timeout);
        this.redisSub.unsubscribe(responseKey);
        resolve(message === 'accepted');
      });
    });
  }

  async handleDriverResponse(driverId: string, rideId: string, accepted: boolean): Promise<void> {
    // Validate offer still exists (not expired, not already accepted)
    const offerKey = `ride:offer:${rideId}:${driverId}`;
    const offer = await this.redis.get(offerKey);
    if (!offer) {
      this.logger.warn({ driverId, rideId }, 'Driver responded to expired offer — ignoring');
      return;
    }

    // Publish response (MatchingService is waiting on this)
    const responseKey = `offer:response:${rideId}:${driverId}`;
    await this.redisPub.publish(responseKey, accepted ? 'accepted' : 'declined');
    await this.redis.del(offerKey);
  }
}
```

### MatchingService — Core Orchestration

```typescript
@Injectable()
export class MatchingService {
  private readonly RADIUS_STEPS_KM = [5, 10, 15];
  private readonly MAX_OFFER_ROUNDS = 5;

  async matchRide(rideId: string, context: MatchingContext): Promise<void> {
    // Acquire distributed lock — prevent duplicate matching
    const lockKey = `matching:lock:${rideId}`;
    const lockAcquired = await this.redis.set(lockKey, '1', 'NX', 'EX', 30);
    if (!lockAcquired) {
      this.logger.warn({ rideId }, 'Matching lock already held — skipping');
      return;
    }

    try {
      await this.updateRideStatus(rideId, RideStatus.MATCHING, context);

      for (const radiusKm of this.RADIUS_STEPS_KM) {
        const candidates = await this.candidateService.findCandidates(
          context.regionId, context.tenantId,
          context.pickupLat, context.pickupLng,
          context.vehicleType, radiusKm,
        );

        if (candidates.length === 0) {
          this.logger.log({ rideId, radiusKm }, 'No candidates, expanding radius');
          continue;
        }

        // Try top candidates in order
        for (const candidate of candidates.slice(0, this.MAX_OFFER_ROUNDS)) {
          const accepted = await this.offerService.sendOffer(rideId, candidate, context);

          if (accepted) {
            await this.assignDriver(rideId, candidate, context);
            return;  // Success path
          }
          // Update acceptance rate for declined candidate
          this.updateDriverAcceptanceRate(candidate.driverId, false);
        }
      }

      // No match found after all radius expansions
      await this.handleMatchingFailure(rideId, context);

    } finally {
      await this.redis.del(lockKey);
    }
  }

  private async assignDriver(rideId: string, candidate: DriverCandidate, context: MatchingContext): Promise<void> {
    // Transactional: update ride + create assignment atomically
    await this.dataSource.transaction(async (em) => {
      await em.update(RideEntity, { id: rideId }, {
        status: RideStatus.DRIVER_ASSIGNED,
        driverId: candidate.driverId,
      });
    });

    // Update Redis
    await this.redis.hset(`ride:active:${rideId}`, { status: RideStatus.DRIVER_ASSIGNED, driverId: candidate.driverId });
    await this.redis.set(`driver:active-ride:${candidate.driverId}`, rideId, 'EX', 4 * 60 * 60);
    await this.redis.hset(`driver:status:${candidate.driverId}`, 'status', DriverStatus.BUSY);

    // Emit assignment event
    await this.kafkaProducer.emit('driver.assignment.created', {
      rideId, driverId: candidate.driverId, tenantId: context.tenantId,
      etaMinutes: candidate.etaMinutes,
    });

    // Notify rider via Socket.IO
    this.realtimeService.emitToRider(context.riderId, RIDER_EVENTS.RIDE_STATUS, {
      rideId, status: RideStatus.DRIVER_ASSIGNED,
      driver: { id: candidate.driverId, etaMinutes: candidate.etaMinutes },
    });

    this.updateDriverAcceptanceRate(candidate.driverId, true);
  }

  private async handleMatchingFailure(rideId: string, context: MatchingContext): Promise<void> {
    await this.dataSource.update(RideEntity, { id: rideId }, { status: RideStatus.FAILED });
    await this.kafkaProducer.emit('ride.matching.failed', { rideId, tenantId: context.tenantId });
    this.realtimeService.emitToRider(context.riderId, RIDER_EVENTS.OFFER_TIMEOUT, { rideId });
  }
}
```

### Unit Tests

```typescript
describe('CandidateService', () => {
  it('returns empty array when no drivers in radius')
  it('filters out OFFLINE and ON_TRIP drivers')
  it('filters by vehicle type')
  it('ranks: lower ETA beats higher ETA ceteris paribus')
  it('ranks: higher rating beats lower rating ceteris paribus')
  it('accepts VehicleType.ANY to match all types')
})

describe('OfferService', () => {
  it('resolves false after OFFER_TTL_SECONDS timeout')
  it('resolves true on accepted response via pub/sub')
  it('ignores response to expired offer')
})

describe('MatchingService', () => {
  it('skips if lock already held (idempotency)')
  it('expands radius if no candidates found in smaller radius')
  it('assigns first driver who accepts')
  it('emits matching.failed if all candidates decline')
  it('releases lock on failure')
})
```

## Update Progress

Check off all Matching Engine items in PROJECT_PROGRESS.md.
