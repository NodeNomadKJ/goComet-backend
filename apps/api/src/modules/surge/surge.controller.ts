import { Controller, Get, Param, Query } from '@nestjs/common';
import { SurgeService } from './surge.service';

@Controller('regions')
export class SurgeController {
  constructor(private readonly surgeService: SurgeService) {}

  @Get(':id/surge-map')
  async getSurgeMap(
    @Param('id') regionId: string,
    @Query('zone') zone?: string,
  ) {
    const multiplier = await this.surgeService.getSurgeMultiplier(regionId, zone);
    return {
      regionId,
      zone: zone ?? 'default',
      multiplier,
      isSurge: multiplier > 1.0,
      updatedAt: new Date().toISOString(),
    };
  }
}
