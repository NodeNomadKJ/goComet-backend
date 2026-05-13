import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '@gocomet/redis';
import { TenantEntity } from './entities/tenant.entity';
import { RegionEntity } from './entities/region.entity';
import { TenantService } from './tenant.service';
import { TenantController } from './tenant.controller';
import { ConfigController } from './config.controller';

@Module({
  imports: [TypeOrmModule.forFeature([TenantEntity, RegionEntity]), RedisModule],
  providers: [TenantService],
  controllers: [TenantController, ConfigController],
  exports: [TenantService, TypeOrmModule],
})
export class TenantModule {}
