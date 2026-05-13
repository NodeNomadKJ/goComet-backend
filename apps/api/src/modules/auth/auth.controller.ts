import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
  Headers,
  Ip,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { AuthService } from './auth.service';
import { RegisterRiderDto } from './dto/register-rider.dto';
import { RegisterDriverDto } from './dto/register-driver.dto';
import { LoginDto } from './dto/login.dto';
import type { AuthResponseDto } from './dto/auth-response.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { JwtPayload } from './interfaces/jwt-payload.interface';
import type { RefreshTokenPayload } from './strategies/jwt-refresh.strategy';

interface ApiResponse<T> {
  data: T;
  meta: { timestamp: string };
}

const wrap = <T>(data: T): ApiResponse<T> => ({
  data,
  meta: { timestamp: new Date().toISOString() },
});

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('rider/register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new rider' })
  async registerRider(
    @Body() dto: RegisterRiderDto,
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-region-id') regionId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResponse<AuthResponseDto>> {
    const result = await this.authService.registerRider(dto, tenantId, regionId, reply);
    return wrap(result);
  }

  @Post('driver/register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new driver' })
  async registerDriver(
    @Body() dto: RegisterDriverDto,
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-region-id') regionId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResponse<AuthResponseDto>> {
    const result = await this.authService.registerDriver(dto, tenantId, regionId, reply);
    return wrap(result);
  }

  @Post('rider/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login as rider — sets HTTP-only cookies' })
  async loginRider(
    @Body() dto: LoginDto,
    @Headers('x-tenant-id') tenantId: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResponse<AuthResponseDto>> {
    const result = await this.authService.login(dto, tenantId, reply, ip);
    return wrap(result);
  }

  @Post('driver/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login as driver — sets HTTP-only cookies' })
  async loginDriver(
    @Body() dto: LoginDto,
    @Headers('x-tenant-id') tenantId: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResponse<AuthResponseDto>> {
    const result = await this.authService.login(dto, tenantId, reply, ip);
    return wrap(result);
  }

  @Post('admin/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login as admin' })
  async loginAdmin(
    @Body() dto: LoginDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResponse<AuthResponseDto>> {
    const result = await this.authService.loginAdmin(dto, reply, ip);
    return wrap(result);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtRefreshGuard)
  @ApiCookieAuth('refresh_token')
  @ApiOperation({ summary: 'Rotate tokens — requires refresh_token cookie' })
  async refresh(
    @CurrentUser() payload: RefreshTokenPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResponse<AuthResponseDto>> {
    const result = await this.authService.refreshTokens(payload, reply);
    return wrap(result);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Logout — clears cookies and blacklists token' })
  async logout(
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ApiResponse<{ message: string }>> {
    await this.authService.logout(
      user.sub,
      user.deviceId,
      user.jti,
      user.exp ?? 0,
      reply,
    );
    return wrap({ message: 'Logged out successfully' });
  }
}
