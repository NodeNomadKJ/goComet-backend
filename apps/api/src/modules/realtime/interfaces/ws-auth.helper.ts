import type { Socket } from 'socket.io';
import type { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import type { WsUser } from './socket-with-user.interface';

export async function authenticateWsClient(
  socket: Socket,
  jwtService: JwtService,
  config: ConfigService,
): Promise<WsUser | null> {
  // Priority 1: handshake auth token (Socket.IO client SDK convention)
  let token = socket.handshake.auth?.token as string | undefined;

  // Priority 2: Authorization header
  if (!token) {
    const auth = socket.handshake.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      token = auth.slice(7);
    }
  }

  // Priority 3: access_token cookie
  if (!token) {
    const cookieHeader = socket.handshake.headers.cookie;
    if (cookieHeader) {
      const match = /(?:^|;\s*)access_token=([^;]+)/.exec(cookieHeader);
      if (match) token = decodeURIComponent(match[1]);
    }
  }

  if (!token) return null;

  try {
    return await jwtService.verifyAsync<WsUser>(token, {
      secret: config.getOrThrow<string>('JWT_SECRET'),
    });
  } catch {
    return null;
  }
}
