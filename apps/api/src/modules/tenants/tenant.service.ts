import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantEntity } from './entities/tenant.entity';
import { RegionEntity } from './entities/region.entity';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { CreateRegionDto } from './dto/create-region.dto';

@Injectable()
export class TenantService {
  constructor(
    @InjectRepository(TenantEntity) private readonly tenantRepo: Repository<TenantEntity>,
    @InjectRepository(RegionEntity) private readonly regionRepo: Repository<RegionEntity>,
  ) {}

  async createTenant(dto: CreateTenantDto): Promise<TenantEntity> {
    const existing = await this.tenantRepo.findOne({ where: { slug: dto.slug } });
    if (existing) throw new ConflictException(`Tenant slug '${dto.slug}' already exists`);

    const tenant = this.tenantRepo.create({
      name: dto.name,
      slug: dto.slug,
      config: dto.config ?? {},
      plan: dto.plan ?? 'STANDARD',
      isActive: true,
      tenantId: '00000000-0000-0000-0000-000000000000',
      regionId: '00000000-0000-0000-0000-000000000000',
    });
    return this.tenantRepo.save(tenant);
  }

  async createRegion(tenantId: string, dto: CreateRegionDto): Promise<RegionEntity> {
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    const region = this.regionRepo.create({
      name: dto.name,
      countryCode: dto.countryCode,
      timezone: dto.timezone ?? 'Asia/Kolkata',
      config: dto.config ?? {},
      isActive: true,
      tenantId,
      regionId: '00000000-0000-0000-0000-000000000000',
    });
    const saved = await this.regionRepo.save(region);

    // self-reference: region's regionId is its own id
    await this.regionRepo.update({ id: saved.id }, { regionId: saved.id });
    saved.regionId = saved.id;
    return saved;
  }

  async findAllTenants(): Promise<TenantEntity[]> {
    return this.tenantRepo.find({ where: { isActive: true } });
  }

  async findTenantBySlug(slug: string): Promise<TenantEntity | null> {
    return this.tenantRepo.findOne({ where: { slug, isActive: true } });
  }

  async findRegionsByTenant(tenantId: string): Promise<RegionEntity[]> {
    return this.regionRepo.find({ where: { tenantId, isActive: true } });
  }

  async getDefaultConfig(): Promise<{ tenantId: string; regionId: string; tenantName: string } | null> {
    const tenant = await this.tenantRepo.findOne({ where: { isActive: true }, order: { createdAt: 'ASC' } });
    if (!tenant) return null;
    const region = await this.regionRepo.findOne({ where: { tenantId: tenant.id, isActive: true }, order: { createdAt: 'ASC' } });
    if (!region) return null;
    return { tenantId: tenant.id, regionId: region.id, tenantName: tenant.name };
  }
}
