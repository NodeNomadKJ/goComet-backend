import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { RedisModule } from '@gocomet/redis';
import { KafkaModule } from './kafka/kafka.module';
import { MatchingModule } from './modules/matching/matching.module';
import { LocationSnapshotConsumer } from './consumers/location-snapshot.consumer';
import { MatchingConsumer } from './consumers/matching.consumer';
import { PaymentConsumer } from './consumers/payment.consumer';
import { NotificationConsumer } from './consumers/notification.consumer';
import { DlqConsumer } from './consumers/dlq.consumer';
import { TripCompletedConsumer } from './consumers/trip-completed.consumer';

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
        synchronize: false,
        logging: config.get<string>('DB_LOGGING') === 'true' ? 'all' : ['error', 'warn'],
        maxQueryExecutionTime: 500,
        extra: { max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 2000 },
      }),
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    RedisModule,
    KafkaModule,
    MatchingModule,
  ],
  providers: [LocationSnapshotConsumer, MatchingConsumer, PaymentConsumer, NotificationConsumer, DlqConsumer, TripCompletedConsumer],
})
export class AppModule {}
