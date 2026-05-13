import { UserRole } from '@gocomet/common';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  tenantId: string;
  regionId: string;
  deviceId: string;
  jti: string;
  iat?: number;
  exp?: number;
}
