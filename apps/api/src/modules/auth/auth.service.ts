import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { v7 as uuidv7 } from 'uuid';
import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { UserRole } from '@gocomet/common';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import { UserService } from '../users/user.service';
import type { RegisterRiderDto } from './dto/register-rider.dto';
import type { RegisterDriverDto } from './dto/register-driver.dto';
import type { LoginDto } from './dto/login.dto';
import type { AuthResponseDto } from './dto/auth-response.dto';
import type { JwtPayload } from './interfaces/jwt-payload.interface';
import type { RefreshTokenPayload } from './strategies/jwt-refresh.strategy';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from './constants/cookie.constants';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly BCRYPT_ROUNDS: number;
  private readonly LOGIN_RATE_LIMIT_MAX = 5;
  private readonly LOGIN_RATE_LIMIT_WINDOW = 15 * 60; // 15 minutes in seconds

  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    this.BCRYPT_ROUNDS = config.get<number>('BCRYPT_ROUNDS', 10);
  }

  async registerRider(
    dto: RegisterRiderDto,
    tenantId: string,
    regionId: string,
    reply: FastifyReply,
  ): Promise<AuthResponseDto> {
    return this.register(dto, UserRole.RIDER, tenantId, regionId, reply);
  }

  async registerDriver(
    dto: RegisterDriverDto,
    tenantId: string,
    regionId: string,
    reply: FastifyReply,
  ): Promise<AuthResponseDto> {
    return this.register(dto, UserRole.DRIVER, tenantId, regionId, reply);
  }

  async loginAdmin(
    dto: LoginDto,
    reply: FastifyReply,
    ip: string,
  ): Promise<AuthResponseDto> {
    await this.enforceLoginRateLimit(ip);

    const user = await this.userService.findAdminByEmail(dto.email);

    const dummyHash = '$2b$12$invalidhashfortimingnormalization.........';
    const passwordMatch = await bcrypt.compare(dto.password, user?.passwordHash ?? dummyHash);

    if (!user || !passwordMatch || !user.isActive) {
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.resetLoginRateLimit(ip);
    await this.userService.updateLastLogin(user.id);

    return this.issueTokens(user.id, user.email, user.role, user.tenantId, user.regionId, reply);
  }

  async login(
    dto: LoginDto,
    tenantId: string,
    reply: FastifyReply,
    ip: string,
  ): Promise<AuthResponseDto> {
    await this.enforceLoginRateLimit(ip);

    const user = await this.userService.findByEmailWithPassword(
      dto.email,
      tenantId,
    );

    // Constant-time compare even on user-not-found to prevent timing attacks
    const dummyHash =
      '$2b$12$invalidhashfortimingnormalization.........';
    const passwordMatch = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? dummyHash,
    );

    if (!user || !passwordMatch || !user.isActive) {
      // Never reveal which field failed
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.resetLoginRateLimit(ip);
    await this.userService.updateLastLogin(user.id);

    return this.issueTokens(user.id, user.email, user.role, user.tenantId, user.regionId, reply);
  }

  async refreshTokens(
    payload: RefreshTokenPayload,
    reply: FastifyReply,
  ): Promise<AuthResponseDto> {
    const sessionKey = `session:${payload.sub}:${payload.deviceId}`;
    const session = await this.redis.hgetall(sessionKey);

    if (!session?.tokenHash) {
      reply.clearCookie(REFRESH_TOKEN_COOKIE.name, { path: REFRESH_TOKEN_COOKIE.options.path });
      throw new UnauthorizedException('Session expired — please log in again');
    }

    // Re-derive the hash of the incoming refresh token's jti and compare
    const expectedHash = this.hashToken(payload.jti);
    if (session.tokenHash !== expectedHash) {
      // Possible token reuse — invalidate entire session
      await this.redis.del(sessionKey);
      reply.clearCookie(REFRESH_TOKEN_COOKIE.name, { path: REFRESH_TOKEN_COOKIE.options.path });
      throw new UnauthorizedException('Token reuse detected — session revoked');
    }

    const user = await this.userService.findById(payload.sub, session['tenantId']);
    if (!user?.isActive) {
      await this.redis.del(sessionKey);
      throw new UnauthorizedException('Account inactive');
    }

    await this.redis.del(sessionKey);
    return this.issueTokens(user.id, user.email, user.role, user.tenantId, user.regionId, reply);
  }

  async logout(
    userId: string,
    deviceId: string,
    jti: string,
    accessTokenExp: number,
    reply: FastifyReply,
  ): Promise<void> {
    await this.redis.del(`session:${userId}:${deviceId}`);

    const ttl = Math.max(accessTokenExp - Math.floor(Date.now() / 1000), 0);
    if (ttl > 0) {
      await this.redis.set(`blacklist:token:${jti}`, '1', 'EX', ttl);
    }

    reply.clearCookie(ACCESS_TOKEN_COOKIE.name, { path: '/' });
    reply.clearCookie(REFRESH_TOKEN_COOKIE.name, { path: REFRESH_TOKEN_COOKIE.options.path });

    this.logger.log({ userId, deviceId }, 'User logged out');
  }

  private async register(
    dto: RegisterRiderDto | RegisterDriverDto,
    role: UserRole,
    tenantId: string,
    regionId: string,
    reply: FastifyReply,
  ): Promise<AuthResponseDto> {
    const [emailTaken, phoneTaken] = await Promise.all([
      this.userService.emailExists(dto.email, tenantId),
      this.userService.phoneExists(dto.phone, tenantId),
    ]);

    if (emailTaken) throw new ConflictException('Email already registered');
    if (phoneTaken) throw new ConflictException('Phone number already registered');

    const passwordHash = await bcrypt.hash(dto.password, this.BCRYPT_ROUNDS);
    const user = await this.userService.create({
      name: dto.name,
      email: dto.email,
      phone: dto.phone,
      passwordHash,
      role,
      tenantId,
      regionId,
    });

    this.logger.log({ userId: user.id, role, tenantId }, 'User registered');
    return this.issueTokens(user.id, user.email, user.role, tenantId, regionId, reply);
  }

  private async issueTokens(
    userId: string,
    email: string,
    role: UserRole,
    tenantId: string,
    regionId: string,
    reply: FastifyReply,
  ): Promise<AuthResponseDto> {
    const deviceId = uuidv7();
    const accessJti = uuidv7();
    const refreshJti = uuidv7();

    const accessPayload: JwtPayload = {
      sub: userId,
      email,
      role,
      tenantId,
      regionId,
      deviceId,
      jti: accessJti,
    };

    // @nestjs/jwt v11 tightened expiresIn to StringValue (branded ms type) — cast is safe
    // because the values are valid ms format strings read from config or env defaults.
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(accessPayload, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        expiresIn: this.config.get('JWT_ACCESS_EXPIRES_IN', '15m') as unknown as number,
      }),
      this.jwtService.signAsync(
        { sub: userId, deviceId, jti: refreshJti },
        {
          secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
          expiresIn: this.config.get('JWT_REFRESH_EXPIRES_IN', '7d') as unknown as number,
        },
      ),
    ]);

    // Store hashed refresh token — never plaintext
    await this.redis.hset(`session:${userId}:${deviceId}`, {
      tokenHash: this.hashToken(refreshJti),
      issuedAt: Date.now(),
      tenantId,
    });
    await this.redis.expire(
      `session:${userId}:${deviceId}`,
      7 * 24 * 60 * 60,
    );

    // Set HTTP-only cookies
    reply.setCookie(ACCESS_TOKEN_COOKIE.name, accessToken, ACCESS_TOKEN_COOKIE.options);
    reply.setCookie(REFRESH_TOKEN_COOKIE.name, refreshToken, REFRESH_TOKEN_COOKIE.options);

    return {
      user: { id: userId, email, role },
      expiresIn: 900,
    };
  }

  private hashToken(jti: string): string {
    return createHash('sha256').update(jti).digest('hex');
  }

  private async enforceLoginRateLimit(ip: string): Promise<void> {
    const key = `login:fail:${ip}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, this.LOGIN_RATE_LIMIT_WINDOW);
    }
    if (count > this.LOGIN_RATE_LIMIT_MAX) {
      throw new UnauthorizedException(
        'Too many failed login attempts — try again in 15 minutes',
      );
    }
  }

  private async resetLoginRateLimit(ip: string): Promise<void> {
    await this.redis.del(`login:fail:${ip}`);
  }
}
