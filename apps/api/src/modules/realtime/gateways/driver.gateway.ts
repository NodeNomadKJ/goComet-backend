import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Namespace } from 'socket.io';
import { DriverStatus, UserRole } from '@gocomet/common';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import { DriverService } from '../../drivers/driver.service';
import { LocationService } from '../../drivers/services/location.service';
import { authenticateWsClient } from '../interfaces/ws-auth.helper';
import type { SocketWithUser } from '../interfaces/socket-with-user.interface';
import { WsEvents, type LocationUpdatePayload, type OfferResponsePayload } from '../events/realtime-event.types';

// Grace period before an unresponsive driver is auto-set offline
const DISCONNECT_GRACE_MS = 30_000;

@WebSocketGateway({ namespace: '/driver' })
export class DriverGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Namespace;

  // userId → timer handle; cleared on reconnect within grace period
  private readonly disconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly logger = new Logger(DriverGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly driverService: DriverService,
    private readonly locationService: LocationService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async handleConnection(client: SocketWithUser): Promise<void> {
    const user = await authenticateWsClient(client, this.jwtService, this.config);

    if (user?.role !== UserRole.DRIVER) {
      client.emit(WsEvents.ERROR, { message: 'Unauthorized' });
      client.disconnect(true);
      return;
    }

    client.data.user = user;

    // Cancel pending offline timer (driver reconnected within grace period)
    const pending = this.disconnectTimers.get(user.sub);
    if (pending) {
      clearTimeout(pending);
      this.disconnectTimers.delete(user.sub);
      this.logger.log({ userId: user.sub }, 'Driver reconnected within grace period — offline timer cancelled');
    }

    // The matching engine keys offers by driver entity ID (driver.id), not userId (user.sub).
    // Resolve the entity ID here so the socket room matches what emitRideOffer targets.
    const driver = await this.driverService.getProfile(user.sub, user.tenantId);
    await client.join(`driver:${driver.id}`);
    client.data.driverId = driver.id;

    // Re-register in Redis if the status TTL expired while the driver was connected
    await this.driverService.refreshRedisPresence(driver.id, user.regionId);

    this.logger.log({ userId: user.sub, driverId: driver.id, tenantId: user.tenantId }, 'Driver connected');
  }

  async handleDisconnect(client: SocketWithUser): Promise<void> {
    const user = client.data?.user;
    if (!user) return;

    this.logger.log({ userId: user.sub }, `Driver disconnected — ${DISCONNECT_GRACE_MS / 1000}s grace timer started`);

    const timer = setTimeout(async () => {
      this.disconnectTimers.delete(user.sub);
      try {
        const driver = await this.driverService.getProfile(user.sub, user.tenantId);
        if (driver.status !== DriverStatus.OFFLINE) {
          await this.driverService.setAvailability(user.sub, user.tenantId, user.regionId, {
            status: DriverStatus.OFFLINE,
          });
          this.logger.warn({ userId: user.sub }, 'Driver auto-set OFFLINE after disconnect grace period');
        }
      } catch (err: unknown) {
        this.logger.error(
          { userId: user.sub, err: (err as Error).message },
          'Failed to auto-offline driver after disconnect',
        );
      }
    }, DISCONNECT_GRACE_MS);

    this.disconnectTimers.set(user.sub, timer);
  }

  @SubscribeMessage(WsEvents.LOCATION_UPDATE)
  async handleLocationUpdate(
    @ConnectedSocket() client: SocketWithUser,
    @MessageBody() data: LocationUpdatePayload,
  ): Promise<void> {
    const user = client.data?.user;
    if (!user) return;
    try {
      await this.locationService.updateLocation(user.sub, user.tenantId, user.regionId, data);
    } catch (err: unknown) {
      client.emit(WsEvents.ERROR, { message: (err as Error).message });
    }
  }

  @SubscribeMessage(WsEvents.OFFER_RESPONSE)
  async handleOfferResponse(
    @ConnectedSocket() client: SocketWithUser,
    @MessageBody() data: OfferResponsePayload,
  ): Promise<void> {
    const user = client.data?.user;
    if (!user) return;

    // Use driver entity ID (stored on connect) — matching engine keys offers by entity ID, not userId
    const driverId = client.data.driverId ?? user.sub;

    const offerKey = `ride:offer:${data.rideId}:${driverId}`;
    const exists = await this.redis.exists(offerKey);
    if (!exists) {
      client.emit(WsEvents.ERROR, { message: 'Offer expired or not found' });
      return;
    }

    await this.redis.del(offerKey);
    const channel = `offer:response:${data.rideId}:${driverId}`;
    await this.redis.publish(channel, data.accepted ? 'accepted' : 'declined');

    this.logger.log({ rideId: data.rideId, driverId, accepted: data.accepted }, 'Offer response published');
  }
}
