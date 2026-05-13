import type { Socket } from 'socket.io';
import { UserRole } from '@gocomet/common';

export interface WsUser {
  sub: string;
  email: string;
  role: UserRole;
  tenantId: string;
  regionId: string;
}

export interface SocketWithUser extends Socket {
  data: {
    user: WsUser;
    driverId?: string;  // driver entity ID (drivers.id), resolved on connect — NOT the same as user.sub
  };
}
