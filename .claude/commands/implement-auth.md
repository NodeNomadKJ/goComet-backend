# /implement-auth

Implement the full authentication system for GOComet. This covers JWT access + refresh tokens
for three user roles: RIDER, DRIVER, ADMIN.

## What to Build

### File Structure

```
apps/api/src/modules/auth/
  auth.module.ts
  auth.controller.ts
  auth.service.ts
  dto/
    register-rider.dto.ts
    register-driver.dto.ts
    login.dto.ts
    refresh-token.dto.ts
    auth-response.dto.ts
  strategies/
    jwt.strategy.ts
    jwt-refresh.strategy.ts
  guards/
    jwt-auth.guard.ts
    roles.guard.ts
  decorators/
    current-user.decorator.ts
    roles.decorator.ts
  interfaces/
    jwt-payload.interface.ts
  tests/
    auth.service.spec.ts

apps/api/src/modules/users/
  user.module.ts
  user.service.ts
  entities/
    user.entity.ts
```

### UserEntity

```typescript
@Entity('users')
@Index(['tenantId', 'regionId', 'email'])
export class UserEntity extends BaseEntity {
  @Column({ unique: true })
  email: string;

  @Column({ unique: true })
  phone: string;

  @Column({ select: false })  // never returned in queries by default
  passwordHash: string;

  @Column({ type: 'enum', enum: UserRole })
  role: UserRole;

  @Column({ default: true })
  isActive: boolean;

  @Column({ nullable: true })
  lastLoginAt: Date;
}
```

### JWT Payload Interface

```typescript
interface JwtPayload {
  sub: string;        // userId
  email: string;
  role: UserRole;
  tenantId: string;
  regionId: string;
  deviceId: string;   // for per-device session management
  iat?: number;
  exp?: number;
}
```

### Auth Service — Core Logic

Implement these methods:

**registerRider(dto, tenantId, regionId)**
- Check email + phone uniqueness (scoped to tenant)
- Hash password with bcrypt (12 rounds)
- Create UserEntity with role RIDER
- Create RiderEntity linked to userId
- Return tokens

**registerDriver(dto, tenantId, regionId)**
- Same as rider but role DRIVER
- Create DriverEntity linked to userId

**login(dto, tenantId)**
- Find user by email (select passwordHash explicitly)
- Compare password with bcrypt.compare
- On match: generate tokens, update lastLoginAt
- On fail: throw UnauthorizedException (do NOT say which field is wrong)

**generateTokens(user, reply: FastifyReply)**
- Access token: JWT, payload includes sub/email/role/tenantId/regionId/deviceId/jti(uuidv7), expires 15m
- Refresh token: JWT, only sub+deviceId+jti, expires 7d
- Store refresh token hash in Redis: `session:{userId}:{deviceId}` HSET { tokenHash, issuedAt }
- Set tokens as HTTP-only cookies on `reply` using ACCESS_TOKEN_COOKIE / REFRESH_TOKEN_COOKIE constants
- Return ONLY `{ user: { id, email, role }, expiresIn: 900 }` — tokens are NOT in the body

**refreshTokens(reply, refreshTokenPayload)**
- Payload comes from `JwtRefreshStrategy.validate` (already verified signature)
- Check Redis: `session:{userId}:{deviceId}` exists with matching hash
- If valid: rotate — delete old hash, generate new pair, set new cookies on `reply`, store new hash
- If invalid/missing: clear both cookies on `reply` then throw UnauthorizedException

**logout(userId, deviceId, jti)**
- Delete Redis key: `session:{userId}:{deviceId}`
- Blacklist jti in Redis: `blacklist:token:{jti}` TTL = remaining access token lifetime
- Cookie clearing is done in the controller (after this method returns), not here

### JWT Strategy

Dual extraction: cookie-first for web clients, `Authorization` header fallback for mobile/API clients.

```typescript
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService, private redisService: RedisService) {
    super({
      // 1. Try HTTP-only cookie (web), 2. Fall back to Bearer header (mobile/API)
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: FastifyRequest) => (req?.cookies as Record<string, string>)?.['access_token'] ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      secretOrKey: config.get('JWT_SECRET'),
      passReqToCallback: true,
    });
  }

  async validate(req: FastifyRequest, payload: JwtPayload) {
    const blacklisted = await this.redisService.get(`blacklist:token:${payload.jti}`);
    if (blacklisted) throw new UnauthorizedException('Token revoked');
    return payload; // attaches to req.user
  }
}
```

### Refresh Token Strategy

Reads `refresh_token` cookie (path-restricted to `/auth/refresh`):

```typescript
@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: FastifyRequest) => (req?.cookies as Record<string, string>)?.['refresh_token'] ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(), // fallback for mobile
      ]),
      secretOrKey: config.get('JWT_REFRESH_SECRET'),
      passReqToCallback: true,
    });
  }

  async validate(req: FastifyRequest, payload: Pick<JwtPayload, 'sub' | 'deviceId' | 'jti'>) {
    return payload;
  }
}
```

### Guards

```typescript
// roles.guard.ts — checks req.user.role against @Roles() decorator
@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles) return true;
    const { user } = context.switchToHttp().getRequest();
    return requiredRoles.includes(user.role);
  }
}
```

### Controller Endpoints

```
POST /auth/rider/register    → registerRider (public)
POST /auth/driver/register   → registerDriver (public)
POST /auth/rider/login       → login (public)
POST /auth/driver/login      → login (public)
POST /auth/admin/login       → login (public, role=ADMIN)
POST /auth/refresh           → refreshTokens (RefreshTokenGuard)
POST /auth/logout            → logout (JwtAuthGuard)
```

Controllers must inject `@Res({ passthrough: false })` to call `reply.setCookie()`.
Fastify requires `passthrough: false` when you want full control of the reply object.

```typescript
@Post('rider/login')
async loginRider(
  @Body() dto: LoginDto,
  @Headers('x-tenant-id') tenantId: string,
  @Res() reply: FastifyReply,
): Promise<void> {
  const result = await this.authService.login(dto, tenantId, reply);
  // Cookies already set inside authService.login via reply
  reply.status(200).send({ data: result, meta: { timestamp: new Date().toISOString() } });
}

@Post('logout')
@UseGuards(JwtAuthGuard)
async logout(
  @CurrentUser() user: JwtPayload,
  @Res() reply: FastifyReply,
): Promise<void> {
  await this.authService.logout(user.sub, user.deviceId, user.jti);
  // Clear both cookies
  reply.clearCookie('access_token', { path: '/' });
  reply.clearCookie('refresh_token', { path: '/auth/refresh' });
  reply.status(200).send({ data: { message: 'Logged out' }, meta: { timestamp: new Date().toISOString() } });
}
```

**Response body shape** — tokens are NEVER in the body:
```json
{
  "data": {
    "user": { "id": "...", "email": "...", "role": "RIDER" },
    "expiresIn": 900
  },
  "meta": { "timestamp": "2026-05-13T..." }
}
```

### DTOs with Validation

RegisterRiderDto:
- email: @IsEmail()
- phone: @Matches(/^\+[1-9]\d{1,14}$/) — E.164 format
- password: @MinLength(8), @Matches(/^(?=.*[A-Z])(?=.*\d)/)
- name: @IsString() @MinLength(2) @MaxLength(100)

LoginDto:
- email: @IsEmail()
- password: @IsString() @IsNotEmpty()

### Cookie Configuration

Tokens are delivered via HTTP-only cookies — never in the response body.
JavaScript cannot read HTTP-only cookies, so XSS cannot steal tokens.

Register `@fastify/cookie` in the Fastify bootstrap:

```typescript
// apps/api/src/main.ts
import fastifyCookie from '@fastify/cookie';

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
await app.register(fastifyCookie);
```

Cookie settings per token type:

```typescript
// shared/constants/cookie.constants.ts
export const ACCESS_TOKEN_COOKIE = {
  name: 'access_token',
  options: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',  // HTTPS only in prod
    sameSite: 'strict' as const,   // blocks CSRF from cross-origin requests
    path: '/',
    maxAge: 900,                   // 15 minutes (seconds)
  },
} as const;

export const REFRESH_TOKEN_COOKIE = {
  name: 'refresh_token',
  options: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: '/auth/refresh',         // CRITICAL: narrowed path — cookie only sent to this endpoint
    maxAge: 7 * 24 * 60 * 60,     // 7 days (seconds)
  },
} as const;
```

### Security Requirements

- Bcrypt rounds: 12 (configurable via env)
- Tokens delivered via HTTP-only Secure cookies — NEVER in response body
- Refresh token cookie path narrowed to `/auth/refresh` (not sent on every request)
- Failed login: no indication of which field (email vs password) is wrong
- Rate limiting: max 5 failed logins per IP per 15min (Redis counter)
- JWT `jti` claim: `v7()` from the `uuid` package, used for blacklisting
- Refresh token: hash stored in Redis (never plaintext)
- `SameSite=strict` provides CSRF protection for same-origin web clients
- Mobile/API clients fall back to `Authorization: Bearer` header (dual extraction)

### Unit Tests Required

```typescript
describe('AuthService', () => {
  it('registers rider: sets access_token and refresh_token cookies on reply')
  it('registers rider: response body does NOT contain accessToken or refreshToken')
  it('rejects registration with duplicate email')
  it('logs in with valid credentials: cookies set, body has user + expiresIn only')
  it('throws on invalid password without revealing which field failed')
  it('refreshes tokens: new cookies set, old refresh token hash deleted from Redis')
  it('logout: clears both cookies and blacklists jti in Redis')
  it('rejects request with blacklisted jti even if token not expired')
})

describe('JwtStrategy', () => {
  it('extracts token from access_token cookie')
  it('falls back to Authorization header when cookie absent')
  it('rejects when jti is blacklisted in Redis')
})

describe('JwtRefreshStrategy', () => {
  it('extracts token from refresh_token cookie')
  it('falls back to Authorization header when cookie absent')
})
```

## Update Progress

Check off all auth items in PROJECT_PROGRESS.md after completing.
Add to Completion Log with today's date.
