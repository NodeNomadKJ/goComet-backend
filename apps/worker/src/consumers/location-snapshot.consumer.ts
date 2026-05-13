import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Kafka, Consumer } from 'kafkajs';
import { KAFKA_TOPICS } from '@gocomet/common';
import type { DomainEvent } from '@gocomet/common';
import { InjectRedis } from '@gocomet/redis';
import type Redis from 'ioredis';

interface LocationUpdatedPayload {
  driverId: string;
  lat: number;
  lng: number;
  regionId: string;
  tenantId: string;
  timestamp: number;
}

// Write to DB at most once per driver per 30 seconds — only a recovery fallback, doesn't need sub-second freshness
const SNAPSHOT_THROTTLE_TTL = 30;
const SNAPSHOT_KEY = (driverId: string) => `driver:snapshot:${driverId}`;

@Injectable()
export class LocationSnapshotConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LocationSnapshotConsumer.name);
  private consumer!: Consumer;

  constructor(
    private readonly config: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async onModuleInit(): Promise<void> {
    const kafka = new Kafka({
      clientId: 'gocomet-worker-location-snapshot',
      brokers: [this.config.get<string>('KAFKA_BROKERS', 'localhost:19092')],
      retry: { initialRetryTime: 100, retries: 8, multiplier: 2 },
    });

    this.consumer = kafka.consumer({ groupId: 'worker-driver.location.updated-batch-consumer' });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: KAFKA_TOPICS.DRIVER_LOCATION_UPDATED, fromBeginning: false });

    await this.consumer.run({
      eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
        // Step 1: deduplicate — keep latest payload per driverId within this batch
        const latest = new Map<string, LocationUpdatedPayload & { offset: string }>();
        for (const message of batch.messages) {
          const raw = message.value?.toString();
          if (!raw) continue;
          try {
            const event = JSON.parse(raw) as DomainEvent<LocationUpdatedPayload>;
            const p = event.payload;
            const existing = latest.get(p.driverId);
            if (!existing || p.timestamp > existing.timestamp) {
              latest.set(p.driverId, { ...p, offset: message.offset });
            }
          } catch {
            // malformed message — skip, location snapshots don't need DLQ
          }
        }

        if (latest.size === 0) {
          resolveOffset(batch.messages.at(-1)!.offset);
          return;
        }

        // Step 2: Redis NX throttle — skip drivers written to DB within the last 30s
        const candidates = [...latest.values()];
        const pipeline = this.redis.pipeline();
        for (const d of candidates) {
          pipeline.set(SNAPSHOT_KEY(d.driverId), '1', 'EX', SNAPSHOT_THROTTLE_TTL, 'NX');
        }
        const results = await pipeline.exec();
        const toWrite = candidates.filter((_, i) => results?.[i]?.[1] === 'OK');

        // Step 3: bulk UPDATE — one query for all eligible drivers
        if (toWrite.length > 0) {
          await this.dataSource.query(
            `UPDATE drivers d
             SET "lastLocationLat"       = v.lat,
                 "lastLocationLng"       = v.lng,
                 "lastLocationUpdatedAt" = NOW()
             FROM unnest($1::uuid[], $2::numeric[], $3::numeric[]) AS v(id, lat, lng)
             WHERE d.id = v.id`,
            [toWrite.map(d => d.driverId), toWrite.map(d => d.lat), toWrite.map(d => d.lng)],
          );
        }

        this.logger.log(
          { batchSize: batch.messages.length, dedupedTo: latest.size, written: toWrite.length },
          'Location snapshot batch written',
        );

        resolveOffset(batch.messages.at(-1)!.offset);
        await heartbeat();
      },
    });

    this.logger.log('Location snapshot batch consumer started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer.disconnect();
  }
}
