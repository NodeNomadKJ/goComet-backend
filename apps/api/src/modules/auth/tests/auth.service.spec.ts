import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { AuthService } from '../auth.service';
import { UserService } from '../../users/user.service';
import { REDIS_CLIENT } from '@gocomet/redis';
import { UserRole } from '@gocomet/common';
import type { FastifyReply } from 'fastify';
import type { UserEntity } from '../../users/entities/user.entity';

const mockUserService = {
  emailExists: jest.fn(),
  phoneExists: jest.fn(),
  create: jest.fn(),
  findByEmailWithPassword: jest.fn(),
  updateLastLogin: jest.fn(),
  findById: jest.fn(),
};

const mockJwtService = {
  signAsync: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string, def?: unknown) => {
    const values: Record<string, unknown> = {
      BCRYPT_ROUNDS: 4, // low rounds for fast tests
      JWT_ACCESS_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '7d',
    };
    return values[key] ?? def;
  }),
  getOrThrow: jest.fn((key: string) => {
    const values: Record<string, string> = {
      JWT_SECRET: 'test-secret-32-chars-long-enough!!',
      JWT_REFRESH_SECRET: 'test-refresh-secret-32-chars-long!',
    };
    if (!values[key]) throw new Error(`Missing config: ${key}`);
    return values[key];
  }),
};

const mockRedis = {
  hset: jest.fn(),
  expire: jest.fn(),
  del: jest.fn(),
  get: jest.fn().mockResolvedValue(null),
  hgetall: jest.fn(),
  incr: jest.fn().mockResolvedValue(1),
  set: jest.fn(),
};

const mockReply = {
  setCookie: jest.fn(),
  clearCookie: jest.fn(),
} as unknown as FastifyReply;

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: mockUserService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfig },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('registerRider', () => {
    it('registers rider and sets cookies — tokens never in return value', async () => {
      mockUserService.emailExists.mockResolvedValue(false);
      mockUserService.phoneExists.mockResolvedValue(false);
      mockUserService.create.mockResolvedValue({
        id: 'user-id',
        email: 'alice@example.com',
        role: UserRole.RIDER,
        tenantId: 'tenant-1',
        regionId: 'region-1',
      } as UserEntity);
      mockJwtService.signAsync.mockResolvedValue('mock-token');

      const result = await service.registerRider(
        { email: 'alice@example.com', phone: '+91999', password: 'Pass1234', name: 'Alice' },
        'tenant-1',
        'region-1',
        mockReply,
      );

      expect(result).not.toHaveProperty('accessToken');
      expect(result).not.toHaveProperty('refreshToken');
      expect(result.user.email).toBe('alice@example.com');
      expect(result.expiresIn).toBe(900);
      expect(mockReply.setCookie).toHaveBeenCalledTimes(2);
    });

    it('throws ConflictException when email already registered', async () => {
      mockUserService.emailExists.mockResolvedValue(true);
      mockUserService.phoneExists.mockResolvedValue(false);

      await expect(
        service.registerRider(
          { email: 'taken@example.com', phone: '+91999', password: 'Pass1234', name: 'X' },
          'tenant-1', 'region-1', mockReply,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when phone already registered', async () => {
      mockUserService.emailExists.mockResolvedValue(false);
      mockUserService.phoneExists.mockResolvedValue(true);

      await expect(
        service.registerRider(
          { email: 'new@example.com', phone: '+91taken', password: 'Pass1234', name: 'X' },
          'tenant-1', 'region-1', mockReply,
        ),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('login', () => {
    it('logs in with valid credentials and sets cookies', async () => {
      const hash = await bcrypt.hash('Pass1234', 4);
      mockUserService.findByEmailWithPassword.mockResolvedValue({
        id: 'user-id',
        email: 'alice@example.com',
        role: UserRole.RIDER,
        tenantId: 'tenant-1',
        regionId: 'region-1',
        passwordHash: hash,
        isActive: true,
      } as UserEntity);
      mockJwtService.signAsync.mockResolvedValue('mock-token');

      const result = await service.login(
        { email: 'alice@example.com', password: 'Pass1234' },
        'tenant-1',
        mockReply,
        '127.0.0.1',
      );

      expect(result.user.email).toBe('alice@example.com');
      expect(mockReply.setCookie).toHaveBeenCalledTimes(2);
      expect(mockUserService.updateLastLogin).toHaveBeenCalledWith('user-id');
    });

    it('throws UnauthorizedException on wrong password — does not reveal which field failed', async () => {
      const hash = await bcrypt.hash('CorrectPass1', 4);
      mockUserService.findByEmailWithPassword.mockResolvedValue({
        id: 'user-id',
        email: 'alice@example.com',
        passwordHash: hash,
        isActive: true,
      } as UserEntity);

      await expect(
        service.login(
          { email: 'alice@example.com', password: 'WrongPass1' },
          'tenant-1', mockReply, '127.0.0.1',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when user not found — same error as wrong password', async () => {
      mockUserService.findByEmailWithPassword.mockResolvedValue(null);

      await expect(
        service.login(
          { email: 'ghost@example.com', password: 'Pass1234' },
          'tenant-1', mockReply, '127.0.0.1',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException after 5 failed attempts from same IP', async () => {
      mockRedis.incr.mockResolvedValue(6); // exceeds limit

      await expect(
        service.login(
          { email: 'a@b.com', password: 'pass' },
          'tenant-1', mockReply, '1.2.3.4',
        ),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('refreshTokens', () => {
    it('rotates tokens and sets new cookies', async () => {
      const crypto = await import('crypto');
      const jti = 'old-jti';
      const hash = crypto.createHash('sha256').update(jti).digest('hex');

      mockRedis.hgetall.mockResolvedValue({
        tokenHash: hash,
        tenantId: 'tenant-1',
      });
      mockUserService.findById.mockResolvedValue({
        id: 'user-id', email: 'alice@example.com',
        role: UserRole.RIDER, tenantId: 'tenant-1',
        regionId: 'region-1', isActive: true,
      } as UserEntity);
      mockJwtService.signAsync.mockResolvedValue('new-token');

      const result = await service.refreshTokens(
        { sub: 'user-id', deviceId: 'device-1', jti },
        mockReply,
      );

      expect(result.expiresIn).toBe(900);
      expect(mockRedis.del).toHaveBeenCalledWith('session:user-id:device-1');
      expect(mockReply.setCookie).toHaveBeenCalledTimes(2);
    });

    it('throws and clears cookie when session not found', async () => {
      mockRedis.hgetall.mockResolvedValue({});

      await expect(
        service.refreshTokens({ sub: 'u', deviceId: 'd', jti: 'j' }, mockReply),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockReply.clearCookie).toHaveBeenCalledWith('refresh_token', expect.any(Object));
    });

    it('revokes session on jti hash mismatch (token reuse attack)', async () => {
      mockRedis.hgetall.mockResolvedValue({
        tokenHash: 'wrong-hash',
        tenantId: 'tenant-1',
      });

      await expect(
        service.refreshTokens({ sub: 'u', deviceId: 'd', jti: 'different-jti' }, mockReply),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockRedis.del).toHaveBeenCalledWith('session:u:d');
    });
  });

  describe('logout', () => {
    it('deletes session, blacklists jti, and clears cookies', async () => {
      const futureExp = Math.floor(Date.now() / 1000) + 900;

      await service.logout('user-id', 'device-1', 'jti-123', futureExp, mockReply);

      expect(mockRedis.del).toHaveBeenCalledWith('session:user-id:device-1');
      expect(mockRedis.set).toHaveBeenCalledWith(
        'blacklist:token:jti-123', '1', 'EX', expect.any(Number),
      );
      expect(mockReply.clearCookie).toHaveBeenCalledTimes(2);
    });
  });

  describe('JwtStrategy (blacklist check)', () => {
    it('access token with blacklisted jti is rejected at strategy level', async () => {
      mockRedis.get.mockResolvedValue('1'); // jti is blacklisted

      const { JwtStrategy } = await import('../strategies/jwt.strategy');
      const strategy = new JwtStrategy(mockConfig as unknown as ConfigService, mockRedis as never);

      await expect(
        strategy.validate({ sub: 'u', email: 'e', role: UserRole.RIDER, tenantId: 't', regionId: 'r', deviceId: 'd', jti: 'blacklisted-jti' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
