import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '@gocomet/common';
import { TenantService } from './tenant.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { CreateRegionDto } from './dto/create-region.dto';

@Controller('admin/tenants')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
export class TenantController {
  constructor(private readonly tenantService: TenantService) {}

  @Post()
  create(@Body() dto: CreateTenantDto) {
    return this.tenantService.createTenant(dto);
  }

  @Get()
  findAll() {
    return this.tenantService.findAllTenants();
  }

  @Get(':id/regions')
  findRegions(@Param('id') id: string) {
    return this.tenantService.findRegionsByTenant(id);
  }

  @Post(':id/regions')
  createRegion(@Param('id') id: string, @Body() dto: CreateRegionDto) {
    return this.tenantService.createRegion(id, dto);
  }
}
