import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveDuplicateProfileColumns1747209600000 implements MigrationInterface {
  name = 'RemoveDuplicateProfileColumns1747209600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "riders" DROP COLUMN IF EXISTS "name"`);
    await queryRunner.query(`ALTER TABLE "riders" DROP COLUMN IF EXISTS "email"`);
    await queryRunner.query(`ALTER TABLE "riders" DROP COLUMN IF EXISTS "phone"`);
    await queryRunner.query(`ALTER TABLE "drivers" DROP COLUMN IF EXISTS "name"`);
    await queryRunner.query(`ALTER TABLE "drivers" DROP COLUMN IF EXISTS "email"`);
    await queryRunner.query(`ALTER TABLE "drivers" DROP COLUMN IF EXISTS "phone"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "riders" ADD COLUMN IF NOT EXISTS "name" character varying NOT NULL DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE "riders" ADD COLUMN IF NOT EXISTS "email" character varying NOT NULL DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE "riders" ADD COLUMN IF NOT EXISTS "phone" character varying NOT NULL DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "name" character varying NOT NULL DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "email" character varying NOT NULL DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "phone" character varying NOT NULL DEFAULT ''`);
  }
}
