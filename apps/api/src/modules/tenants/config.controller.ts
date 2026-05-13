import { Controller, Get } from '@nestjs/common';
import { TenantService } from './tenant.service';

@Controller('config')
export class ConfigController {
  constructor(private readonly tenantService: TenantService) {}

  @Get()
  getDefaultConfig() {
    return this.tenantService.getDefaultConfig();
  }
}
