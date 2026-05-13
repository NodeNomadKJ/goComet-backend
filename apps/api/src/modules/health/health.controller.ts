import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { HealthService, HealthStatus } from './health.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Health check — DB, Redis liveness' })
  async check(): Promise<HealthStatus> {
    const status = await this.healthService.check();
    const allUp = Object.values(status.services).every((s) => s === 'up');
    if (!allUp) throw new ServiceUnavailableException(status);
    return status;
  }
}
