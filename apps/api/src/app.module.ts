import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from '@gocomet/redis';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { RiderModule } from './modules/riders/rider.module';
import { DriverModule } from './modules/drivers/driver.module';
import { RideModule } from './modules/rides/ride.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { KafkaModule } from './modules/kafka/kafka.module';
import { TripModule } from './modules/trips/trip.module';
import { PaymentModule } from './modules/payments/payment.module';
import { TenantModule } from './modules/tenants/tenant.module';
import { SurgeModule } from './modules/surge/surge.module';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware';
import { TenantMiddleware } from './modules/tenants/tenant.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '../../.env' }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get<string>('DB_USER', 'gocomet'),
        password: config.get<string>('DB_PASSWORD', 'gocomet_dev'),
        database: config.get<string>('DB_NAME', 'gocomet_rides'),
        autoLoadEntities: true,
        synchronize: config.get<string>('DB_SYNC') === 'true',
        logging: config.get<string>('DB_LOGGING') === 'true' ? 'all' : ['error', 'warn'],
        maxQueryExecutionTime: 500,
        extra: { max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 2000 },
      }),
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    RedisModule,
    KafkaModule,
    HealthModule,
    AuthModule,
    RiderModule,
    DriverModule,
    RideModule,
    RealtimeModule,
    TripModule,
    PaymentModule,
    TenantModule,
    SurgeModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
    consumer
      .apply(TenantMiddleware)
      .exclude('/health', '/health/(.*)', '/docs', '/docs/(.*)', '/admin/(.*)', '/auth/admin', '/auth/admin/(.*)', '/config', '/config/(.*)')
      .forRoutes('*');
  }
}
