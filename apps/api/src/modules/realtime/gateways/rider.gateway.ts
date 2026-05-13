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
import { UserRole } from '@gocomet/common';
import { authenticateWsClient } from '../interfaces/ws-auth.helper';
import type { SocketWithUser } from '../interfaces/socket-with-user.interface';
import { WsEvents } from '../events/realtime-event.types';

@WebSocketGateway({ namespace: '/rider' })
export class RiderGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Namespace;

  private readonly logger = new Logger(RiderGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async handleConnection(client: SocketWithUser): Promise<void> {
    const user = await authenticateWsClient(client, this.jwtService, this.config);

    if (!user || user.role !== UserRole.RIDER) {
      client.emit(WsEvents.ERROR, { message: 'Unauthorized' });
      client.disconnect(true);
      return;
    }

    client.data.user = user;
    // Personal room — for direct messages to this rider
    await client.join(`user:${user.sub}`);

    this.logger.log({ userId: user.sub, tenantId: user.tenantId }, 'Rider connected');
  }

  async handleDisconnect(client: SocketWithUser): Promise<void> {
    const user = client.data?.user;
    if (user) {
      this.logger.log({ userId: user.sub }, 'Rider disconnected');
    }
  }

  // Rider explicitly joins a ride room to receive live updates for that ride
  @SubscribeMessage(WsEvents.JOIN_RIDE_ROOM)
  async handleJoinRideRoom(
    @ConnectedSocket() client: SocketWithUser,
    @MessageBody() data: { rideId: string },
  ): Promise<{ joined: boolean }> {
    const user = client.data?.user;
    if (!user || !data?.rideId) return { joined: false };

    // TODO Phase 3: verify rideId belongs to this rider before joining
    await client.join(`ride:${data.rideId}`);
    this.logger.log({ rideId: data.rideId, userId: user.sub }, 'Rider joined ride room');
    return { joined: true };
  }
}
