# /implement-realtime

Implement real-time bidirectional communication via Socket.IO with Redis adapter.
Prerequisite: Phase 1 complete.

## What to Build

### File Structure

```
apps/api/src/modules/realtime/
  realtime.module.ts
  rider.gateway.ts         ← /rider namespace
  driver.gateway.ts        ← /driver namespace
  realtime.service.ts      ← shared emit helpers
  interfaces/
    socket-events.interface.ts
  guards/
    ws-jwt.guard.ts
  adapters/
    redis-io.adapter.ts
  tests/
    rider.gateway.spec.ts
    driver.gateway.spec.ts
```

### Redis IO Adapter (multi-node support)

```typescript
// apps/api/src/adapters/redis-io.adapter.ts
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { ServerOptions } from 'socket.io';

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter>;

  async connectToRedis(): Promise<void> {
    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: process.env.CORS_ORIGINS?.split(',') || '*' },
      transports: ['websocket'],  // no long-polling in production
    });
    server.adapter(this.adapterConstructor);
    return server;
  }
}
```

Bootstrap (apps/api/src/main.ts):
```typescript
const redisIoAdapter = new RedisIoAdapter(app);
await redisIoAdapter.connectToRedis();
app.useWebSocketAdapter(redisIoAdapter);
```

### WebSocket JWT Guard

```typescript
@Injectable()
export class WsJwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const client: Socket = context.switchToWs().getClient();
    const token = client.handshake.auth?.token || client.handshake.headers?.authorization?.split(' ')[1];
    if (!token) {
      client.disconnect();
      return false;
    }
    try {
      const payload = this.jwtService.verify<JwtPayload>(token, { secret: this.config.get('JWT_SECRET') });
      client.data.user = payload;
      return true;
    } catch {
      client.disconnect();
      return false;
    }
  }
}
```

### Rider Gateway (/rider namespace)

```typescript
@WebSocketGateway({ namespace: '/rider', transports: ['websocket'] })
@UseGuards(WsJwtGuard)
export class RiderGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  async handleConnection(client: Socket) {
    const user = client.data.user as JwtPayload;
    // Join personal room
    await client.join(`rider:${user.sub}`);
    // Join active ride room if exists
    const activeRide = await this.rideService.getActiveRide(user.sub, user.tenantId);
    if (activeRide) await client.join(`ride:${activeRide.id}`);
    this.logger.log(`Rider ${user.sub} connected`);
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Rider ${client.data.user?.sub} disconnected`);
  }

  // Rider subscribes to their ride room for driver location updates
  @SubscribeMessage('join:ride')
  async joinRideRoom(client: Socket, rideId: string) {
    // Verify this rider owns this ride
    const ride = await this.rideService.getRide(rideId, client.data.user.sub, client.data.user.tenantId);
    await client.join(`ride:${rideId}`);
    return { event: 'joined', rideId };
  }
}
```

**Events emitted TO rider client:**
- `ride:status` — `{ rideId, status, driverId?, eta? }`
- `driver:location` — `{ rideId, lat, lng, heading, speed }`
- `ride:offer:timeout` — matching failed, no drivers available
- `payment:completed` — `{ rideId, amount, receiptUrl }`

### Driver Gateway (/driver namespace)

```typescript
@WebSocketGateway({ namespace: '/driver', transports: ['websocket'] })
@UseGuards(WsJwtGuard)
export class DriverGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;

  async handleConnection(client: Socket) {
    const user = client.data.user as JwtPayload;
    await client.join(`driver:${user.sub}`);
    // Mark driver as connected in Redis
    await this.redis.hset(`driver:status:${user.sub}`, 'socketConnected', '1');
  }

  async handleDisconnect(client: Socket) {
    const user = client.data.user;
    if (!user) return;
    await this.redis.hset(`driver:status:${user.sub}`, 'socketConnected', '0');
    // Schedule availability timeout: if not reconnected in 30s, mark offline
    await this.redis.set(`driver:disconnect-timer:${user.sub}`, '1', 'EX', 30);
    // A cron job checks these keys and marks driver offline
  }

  @SubscribeMessage('offer:response')
  async handleOfferResponse(client: Socket, payload: { rideId: string; accepted: boolean }) {
    const driverId = client.data.user.sub;
    await this.matchingService.handleOfferResponse(driverId, payload.rideId, payload.accepted);
  }
}
```

**Events emitted TO driver client:**
- `ride:offer` — `{ rideId, pickupLat, pickupLng, pickupAddress, dropAddress, fareEstimate, expiresAt }`
- `trip:update` — `{ tripId, status, riderLat?, riderLng? }`
- `offer:expired` — offer timed out (driver didn't respond)

### RealtimeService — Shared Emit Helpers

```typescript
@Injectable()
export class RealtimeService {
  constructor(
    @InjectNamespace('/rider') private riderServer: Server,
    @InjectNamespace('/driver') private driverServer: Server,
  ) {}

  emitToRider(riderId: string, event: string, data: unknown) {
    this.riderServer.to(`rider:${riderId}`).emit(event, data);
  }

  emitToRide(rideId: string, event: string, data: unknown) {
    this.riderServer.to(`ride:${rideId}`).emit(event, data);
  }

  emitToDriver(driverId: string, event: string, data: unknown) {
    this.driverServer.to(`driver:${driverId}`).emit(event, data);
  }

  broadcastDriverLocation(rideId: string, lat: number, lng: number, heading: number) {
    this.emitToRide(rideId, 'driver:location', { rideId, lat, lng, heading, ts: Date.now() });
  }

  sendDriverOffer(driverId: string, offer: RideOffer) {
    this.emitToDriver(driverId, 'ride:offer', offer);
  }
}
```

### Socket.IO Event Type Definitions

Define all event names as constants to avoid typos:

```typescript
// interfaces/socket-events.interface.ts
export const RIDER_EVENTS = {
  RIDE_STATUS: 'ride:status',
  DRIVER_LOCATION: 'driver:location',
  OFFER_TIMEOUT: 'ride:offer:timeout',
  PAYMENT_COMPLETED: 'payment:completed',
} as const;

export const DRIVER_EVENTS = {
  RIDE_OFFER: 'ride:offer',
  TRIP_UPDATE: 'trip:update',
  OFFER_EXPIRED: 'offer:expired',
} as const;
```

### Integration with RealtimeService

Other modules inject RealtimeService to push events:
- TripService calls `realtimeService.emitToRide(rideId, RIDER_EVENTS.RIDE_STATUS, {...})`
- MatchingService calls `realtimeService.sendDriverOffer(driverId, offer)`
- LocationService calls `realtimeService.broadcastDriverLocation(rideId, lat, lng, heading)`

### Unit Tests

```typescript
describe('WsJwtGuard', () => {
  it('allows connection with valid JWT')
  it('disconnects client with missing token')
  it('disconnects client with expired token')
})

describe('RiderGateway', () => {
  it('joins personal room on connection')
  it('joins active ride room if ride exists')
  it('verifies ride ownership before joining ride room')
})

describe('DriverGateway', () => {
  it('sets socketConnected=1 on connect in Redis')
  it('sets socketConnected=0 and starts disconnect timer on disconnect')
  it('routes offer response to matching service')
})
```

## Update Progress

Check off all Realtime Gateway items in PROJECT_PROGRESS.md.
