import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RideService } from './ride.service';
import { CreateRideDto } from './dto/create-ride.dto';
import { FareEstimateDto } from './dto/fare-estimate.dto';
import { CancelRideDto } from './dto/cancel-ride.dto';
import { RideHistoryQueryDto } from '../riders/dto/ride-history-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import { UserRole } from '@gocomet/common';

interface ApiResponse<T> {
  data: T;
  meta: { timestamp: string };
}

const wrap = <T>(data: T): ApiResponse<T> => ({
  data,
  meta: { timestamp: new Date().toISOString() },
});

@ApiTags('Rides')
@Controller('rides')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiCookieAuth('access_token')
export class RideController {
  constructor(private readonly rideService: RideService) {}

  @Post('fare-estimate')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.RIDER)
  @ApiOperation({ summary: 'Estimate fare — no side effects, reads surge from Redis' })
  async estimateFare(@CurrentUser() user: JwtPayload, @Body() dto: FareEstimateDto) {
    const estimate = await this.rideService.estimateFare(dto, user.regionId);
    return wrap(estimate);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRole.RIDER)
  @ApiOperation({ summary: 'Request a ride — idempotent via X-Idempotency-Key header' })
  @ApiHeader({ name: 'x-idempotency-key', required: true, description: 'Client-generated UUID v4/v7 — replays return same response' })
  async createRide(
    @CurrentUser() user: JwtPayload,
    @Headers('x-idempotency-key') idempotencyKey: string,
    @Body() dto: CreateRideDto,
  ) {
    if (!idempotencyKey) throw new BadRequestException('X-Idempotency-Key header is required');
    const ride = await this.rideService.createRide(user.sub, user.tenantId, user.regionId, idempotencyKey, dto);
    return wrap(ride);
  }

  @Get('me/active')
  @Roles(UserRole.RIDER)
  @ApiOperation({ summary: 'Get current active ride for rider — null if none in progress' })
  async getActiveRide(@CurrentUser() user: JwtPayload) {
    const ride = await this.rideService.getActiveRideByRider(user.sub, user.tenantId);
    return wrap(ride);
  }

  @Get(':rideId')
  @Roles(UserRole.RIDER, UserRole.DRIVER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get ride details — accessible by rider and assigned driver' })
  async getRide(
    @CurrentUser() user: JwtPayload,
    @Param('rideId', ParseUUIDPipe) rideId: string,
  ) {
    const ride = await this.rideService.getRide(rideId, user.tenantId, user.sub);
    return wrap(ride);
  }

  @Delete(':rideId/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.RIDER)
  @ApiOperation({ summary: 'Cancel a ride — only allowed in REQUESTED or MATCHING status' })
  async cancelRide(
    @CurrentUser() user: JwtPayload,
    @Param('rideId', ParseUUIDPipe) rideId: string,
    @Body() dto: CancelRideDto,
  ) {
    const ride = await this.rideService.cancelRide(rideId, user.tenantId, user.sub, dto.reason);
    return wrap(ride);
  }

  @Get()
  @Roles(UserRole.RIDER)
  @ApiOperation({ summary: 'Paginated ride history for current rider' })
  async getRideHistory(@CurrentUser() user: JwtPayload, @Query() query: RideHistoryQueryDto) {
    const result = await this.rideService.getRidesByRider(user.sub, user.tenantId, query.page, query.limit);
    return wrap(result);
  }
}
