import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import { DataSource } from 'typeorm';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USER ?? 'gocomet',
  password: process.env.DB_PASSWORD ?? 'gocomet_dev',
  database: process.env.DB_NAME ?? 'gocomet_rides',
  entities: [path.join(__dirname, '**/*.entity.ts')],
  migrations: [path.join(__dirname, 'migrations/*.ts')],
  logging: true,
});
