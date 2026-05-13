import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import { UserRole } from '@gocomet/common';
import { TripService } from './trip.service';
import { CancelTripDto } from './dto/cancel-trip.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';

const IDEMPOTENCY_TTL = 24 * 60 * 60;

interface ApiResponse<T> {
  data: T;
  meta: { timestamp: string };
}

const wrap = <T>(data: T): ApiResponse<T> => ({
  data,
  meta: { timestamp: new Date().toISOString() },
});

@Controller('trips')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TripController {
  constructor(
    private readonly tripService: TripService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  @Post('me/active')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  async getActiveTrip(@CurrentUser() user: JwtPayload) {
    const trip = await this.tripService.getDriverActiveTrip(user.sub, user.tenantId);
    return wrap(trip);
  }

  @Get('me/active')
  @Roles(UserRole.DRIVER)
  async getActiveTripGet(@CurrentUser() user: JwtPayload) {
    const trip = await this.tripService.getDriverActiveTrip(user.sub, user.tenantId);
    return wrap(trip);
  }

  @Get('me/history')
  @Roles(UserRole.DRIVER)
  async getDriverTripHistory(
    @CurrentUser() user: JwtPayload,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const result = await this.tripService.getDriverTripHistory(
      user.sub,
      user.tenantId,
      Number(page),
      Number(limit),
    );
    return wrap(result);
  }

  @Get(':id')
  @Roles(UserRole.DRIVER, UserRole.RIDER)
  async getTrip(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    const trip = await this.tripService.getTrip(id, user.tenantId, user.sub);
    return wrap(trip);
  }

  @Post(':id/driver-arriving')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  async driverArriving(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    const trip = await this.tripService.markArriving(id, user.tenantId, user.sub);
    return wrap(trip);
  }

  @Post(':id/driver-arrived')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  async driverArrived(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    const trip = await this.tripService.markArrived(id, user.tenantId, user.sub);
    return wrap(trip);
  }

  @Post(':id/start')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  async startRide(@CurrentUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    const trip = await this.tripService.startRide(id, user.tenantId, user.sub);
    return wrap(trip);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER)
  async completeRide(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-idempotency-key') idempotencyKey: string,
  ) {
    if (!idempotencyKey) throw new BadRequestException('X-Idempotency-Key header is required');

    const cacheKey = `idempotency:trips:complete:${user.tenantId}:${idempotencyKey}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as ApiResponse<unknown>;
    }

    const trip = await this.tripService.completeRide(id, user.tenantId, user.sub);
    const response = wrap(trip);

    await this.redis.set(cacheKey, JSON.stringify(response), 'EX', IDEMPOTENCY_TTL);

    return response;
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.DRIVER, UserRole.RIDER)
  async cancelTrip(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelTripDto,
  ) {
    const actorRole = user.role === UserRole.DRIVER ? 'DRIVER' : 'RIDER';
    const trip = await this.tripService.cancelTrip(id, user.tenantId, user.sub, actorRole, dto.reason);
    return wrap(trip);
  }
}
