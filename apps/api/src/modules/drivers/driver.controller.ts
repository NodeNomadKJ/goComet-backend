import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DriverService } from './driver.service';
import { LocationService } from './services/location.service';
import { UpdateDriverDto } from './dto/update-driver.dto';
import { AvailabilityDto } from './dto/availability.dto';
import { AddVehicleDto } from './dto/add-vehicle.dto';
import { LocationUpdateDto } from './dto/location-update.dto';
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

@ApiTags('Drivers')
@Controller('drivers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.DRIVER)
@ApiCookieAuth('access_token')
export class DriverController {
  constructor(
    private readonly driverService: DriverService,
    private readonly locationService: LocationService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Get current driver profile — creates it on first access' })
  async getProfile(@CurrentUser() user: JwtPayload) {
    const driver = await this.driverService.findOrCreateProfile(user.sub, user.tenantId, user.regionId);
    return wrap(driver);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update driver profile (name, phone)' })
  async updateProfile(@CurrentUser() user: JwtPayload, @Body() dto: UpdateDriverDto) {
    const driver = await this.driverService.updateProfile(user.sub, user.tenantId, dto);
    return wrap(driver);
  }

  @Post('location')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Push GPS location — updates Redis GEO index (max 2 req/s per driver)' })
  async updateLocation(@CurrentUser() user: JwtPayload, @Body() dto: LocationUpdateDto): Promise<void> {
    await this.locationService.updateLocation(user.sub, user.tenantId, user.regionId, dto);
  }

  @Post('me/availability')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Go online (AVAILABLE) or offline — updates Redis GEO and status key' })
  async setAvailability(@CurrentUser() user: JwtPayload, @Body() dto: AvailabilityDto) {
    const driver = await this.driverService.setAvailability(user.sub, user.tenantId, user.regionId, dto);
    return wrap({ status: driver.status, activeVehicleId: driver.activeVehicleId });
  }

  @Post('me/vehicles')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a vehicle' })
  async addVehicle(@CurrentUser() user: JwtPayload, @Body() dto: AddVehicleDto) {
    const vehicle = await this.driverService.addVehicle(user.sub, user.tenantId, user.regionId, dto);
    return wrap(vehicle);
  }

  @Get('me/vehicles')
  @ApiOperation({ summary: 'List registered vehicles' })
  async getVehicles(@CurrentUser() user: JwtPayload) {
    const vehicles = await this.driverService.getVehicles(user.sub, user.tenantId);
    return wrap(vehicles);
  }

  @Get('me/trips')
  @ApiOperation({ summary: 'Paginated trip history' })
  async getTrips(@CurrentUser() user: JwtPayload, @Query() query: RideHistoryQueryDto) {
    const profile = await this.driverService.getProfile(user.sub, user.tenantId);
    const result = await this.driverService.getTrips(profile.id, user.tenantId, query.page, query.limit);
    return wrap(result);
  }

  @Get('me/earnings')
  @ApiOperation({ summary: 'Earnings summary' })
  async getEarnings(@CurrentUser() user: JwtPayload) {
    const profile = await this.driverService.getProfile(user.sub, user.tenantId);
    const result = await this.driverService.getEarnings(profile.id, user.tenantId);
    return wrap(result);
  }
}
