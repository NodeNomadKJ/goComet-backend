import { Module } from '@nestjs/common';

// Intentionally empty — TypeORM is initialised in each app's AppModule via
// TypeOrmModule.forRootAsync() so that the same @nestjs/typeorm instance is
// used throughout the app, avoiding token-mismatch from pnpm peer deduplication.
@Module({})
export class DatabaseModule {}
