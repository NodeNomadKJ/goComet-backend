import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRideStatusIndexes1747296000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Covers getActiveRideByRider and getRidesByRider — both filter on (tenantId, riderId, status)
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_rides_tenant_rider_status" ON "rides" ("tenantId", "riderId", "status")`,
    );
    // Covers driver-side queries in matching and trip state machine
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_rides_tenant_driver_status" ON "rides" ("tenantId", "driverId", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rides_tenant_rider_status"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rides_tenant_driver_status"`);
  }
}
