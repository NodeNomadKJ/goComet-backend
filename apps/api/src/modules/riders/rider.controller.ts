import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RiderService } from './rider.service';
import { UpdateRiderDto } from './dto/update-rider.dto';
import { AddPaymentMethodDto } from './dto/add-payment-method.dto';
import { RideHistoryQueryDto } from './dto/ride-history-query.dto';
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

@ApiTags('Riders')
@Controller('riders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.RIDER)
@ApiCookieAuth('access_token')
export class RiderController {
  constructor(private readonly riderService: RiderService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current rider profile — creates it on first access' })
  async getProfile(@CurrentUser() user: JwtPayload) {
    const rider = await this.riderService.findOrCreateProfile(user.sub, user.tenantId, user.regionId);
    return wrap(rider);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update rider profile (name, phone, preferences)' })
  async updateProfile(@CurrentUser() user: JwtPayload, @Body() dto: UpdateRiderDto) {
    const rider = await this.riderService.updateProfile(user.sub, user.tenantId, dto);
    return wrap(rider);
  }

  @Get('me/rides')
  @ApiOperation({ summary: 'Paginated ride history for current rider' })
  async getRideHistory(@CurrentUser() user: JwtPayload, @Query() query: RideHistoryQueryDto) {
    const profile = await this.riderService.getProfile(user.sub, user.tenantId);
    const result = await this.riderService.getRideHistory(profile.id, user.tenantId, query.page, query.limit);
    return wrap(result);
  }

  @Get('me/payment-methods')
  @ApiOperation({ summary: 'List saved payment methods' })
  async getPaymentMethods(@CurrentUser() user: JwtPayload) {
    const profile = await this.riderService.getProfile(user.sub, user.tenantId);
    const methods = await this.riderService.getPaymentMethods(profile.id, user.tenantId);
    return wrap(methods);
  }

  @Post('me/payment-methods')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a payment method' })
  async addPaymentMethod(@CurrentUser() user: JwtPayload, @Body() dto: AddPaymentMethodDto) {
    const profile = await this.riderService.getProfile(user.sub, user.tenantId);
    const method = await this.riderService.addPaymentMethod(profile.id, user.tenantId, user.regionId, dto);
    return wrap(method);
  }

  @Post('me/payment-methods/:methodId/default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a payment method as default' })
  async setDefault(
    @CurrentUser() user: JwtPayload,
    @Param('methodId', ParseUUIDPipe) methodId: string,
  ) {
    const profile = await this.riderService.getProfile(user.sub, user.tenantId);
    await this.riderService.setDefaultPaymentMethod(profile.id, user.tenantId, methodId);
    return wrap({ message: 'Default payment method updated' });
  }
}
