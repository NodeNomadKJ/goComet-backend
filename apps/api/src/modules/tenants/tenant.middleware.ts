import { Injectable, NestMiddleware } from '@nestjs/common';
import { IncomingMessage, ServerResponse } from 'node:http';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';
import { TenantService } from './tenant.service';

// Extend IncomingMessage so downstream code can read tenantId off the request
declare module 'node:http' {
  interface IncomingMessage {
    tenantId?: string;
    tenantSlug?: string;
  }
}

const TENANT_SLUG_TTL = 5 * 60; // 5 minutes — tenants don't change frequently
const tenantSlugKey = (slug: string) => `tenant:slug:${slug}`;

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly tenantService: TenantService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async use(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    // Skip tenant resolution for CORS preflight — no tenant header is sent on OPTIONS
    if (req.method === 'OPTIONS') {
      next();
      return;
    }

    const headerTenantId = req.headers['x-tenant-id'] as string | undefined;
    if (headerTenantId) {
      req.tenantId = headerTenantId;
      next();
      return;
    }

    // fall back to subdomain: {slug}.api.gocomet.com
    const host = (req.headers.host ?? '').split(':')[0];
    const subdomain = host.split('.')[0];
    if (subdomain && subdomain !== 'api' && subdomain !== 'localhost') {
      // Redis-first: avoids a Postgres hit on every subdomain-resolved request
      const cached = await this.redis.get(tenantSlugKey(subdomain));
      if (cached) {
        const { id, slug } = JSON.parse(cached) as { id: string; slug: string };
        req.tenantId = id;
        req.tenantSlug = slug;
        next();
        return;
      }

      const tenant = await this.tenantService.findTenantBySlug(subdomain);
      if (tenant) {
        await this.redis.set(tenantSlugKey(subdomain), JSON.stringify({ id: tenant.id, slug: tenant.slug }), 'EX', TENANT_SLUG_TTL);
        req.tenantId = tenant.id;
        req.tenantSlug = tenant.slug;
        next();
        return;
      }
    }

    const origin = req.headers['origin'] as string | undefined;
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        statusCode: 400,
        message: 'Tenant could not be resolved. Provide X-Tenant-ID header or use a tenant subdomain.',
        timestamp: new Date().toISOString(),
      }),
    );
  }
}
