import { UserRole } from '@gocomet/common';

export class AuthUserDto {
  id: string;
  email: string;
  role: UserRole;
}

export class AuthResponseDto {
  user: AuthUserDto;
  expiresIn: number; // seconds — 900 for 15m access token
}
