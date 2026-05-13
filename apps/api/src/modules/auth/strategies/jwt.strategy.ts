import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import type { FastifyRequest } from 'fastify';
import type { JwtPayload } from '../interfaces/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        // 1. HTTP-only cookie (web clients)
        (req: FastifyRequest) =>
          (req?.cookies as Record<string, string> | undefined)?.['access_token'] ?? null,
        // 2. Authorization: Bearer header (mobile / API clients)
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      passReqToCallback: false,
    });
  }

  async validate(payload: JwtPayload): Promise<JwtPayload> {
    const blacklisted = await this.redis.get(`blacklist:token:${payload.jti}`);
    if (blacklisted) throw new UnauthorizedException('Token has been revoked');
    return payload;
  }
}
