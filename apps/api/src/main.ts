// Load root .env before anything else — ConfigModule runs too late for this check
// path resolves to monorepo root from both apps/api/src (ts-node) and apps/api/dist (node)
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({ path: require('node:path').resolve(__dirname, '../../..', '.env') });

if (process.env.NEW_RELIC_ENABLED === 'true') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('newrelic');
}

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { RedisIoAdapter } from './common/adapters/redis-io.adapter';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { bufferLogs: true },
  );

  await app.register(fastifyCors as unknown as Parameters<typeof app.register>[0], {
    origin: true,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['x-correlation-id'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-tenant-id',
      'x-region-id',
      'x-idempotency-key',
      'x-correlation-id',
    ],
  });

  // @fastify/cookie v11 augments FastifyInstance after registration — the input type
  // paradox is a known TypeScript limitation with Fastify plugins; cast is safe here.
  await app.register(fastifyCookie as unknown as Parameters<typeof app.register>[0]);

  const redisIoAdapter = new RedisIoAdapter(app);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  const swagger = new DocumentBuilder()
    .setTitle('GOComet Ride Hailing API')
    .setDescription('Production-grade ride-hailing backend')
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('access_token')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT', 3000);

  await app.listen(port, '0.0.0.0');
  logger.log(`API running on port ${port}`);
  logger.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap().catch((err: unknown) => {
  console.error('Bootstrap failed:', (err as Error).message ?? err);
  console.error((err as Error).stack ?? '');
  process.exit(1);
});
