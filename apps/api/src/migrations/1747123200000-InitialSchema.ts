import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1747123200000 implements MigrationInterface {
  name = 'InitialSchema1747123200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Enum types — wrapped in DO blocks so they're safe to re-run
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "users_role_enum" AS ENUM ('RIDER', 'DRIVER', 'ADMIN'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "drivers_status_enum" AS ENUM ('OFFLINE', 'AVAILABLE', 'BUSY', 'ON_TRIP'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "vehicles_type_enum" AS ENUM ('ECONOMY', 'PREMIUM', 'XL', 'AUTO', 'BIKE', 'ANY'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "rider_payment_methods_type_enum" AS ENUM ('CARD', 'UPI', 'WALLET', 'CASH'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "rides_status_enum" AS ENUM ('REQUESTED', 'MATCHING', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'RIDE_STARTED', 'COMPLETED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'CANCELLED', 'FAILED'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "rides_vehicletype_enum" AS ENUM ('ECONOMY', 'PREMIUM', 'XL', 'AUTO', 'BIKE', 'ANY'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "trips_status_enum" AS ENUM ('DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'RIDE_STARTED', 'COMPLETED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'CANCELLED', 'FAILED'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "trips_paymentstatus_enum" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "trip_events_fromstatus_enum" AS ENUM ('DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'RIDE_STARTED', 'COMPLETED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'CANCELLED', 'FAILED'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "trip_events_tostatus_enum" AS ENUM ('DRIVER_ASSIGNED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'RIDE_STARTED', 'COMPLETED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'CANCELLED', 'FAILED'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "payments_status_enum" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED'); EXCEPTION WHEN duplicate_object THEN null; END $$`);

    // tenants
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "tenants" (
        "id"        uuid          NOT NULL,
        "tenantId"  uuid          NOT NULL,
        "regionId"  uuid          NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "isDeleted" boolean       NOT NULL DEFAULT false,
        "name"      character varying NOT NULL,
        "slug"      character varying NOT NULL,
        "config"    jsonb         NOT NULL DEFAULT '{}',
        "plan"      character varying NOT NULL DEFAULT 'STANDARD',
        "isActive"  boolean       NOT NULL DEFAULT true,
        CONSTRAINT "PK_tenants" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_tenants_slug" ON "tenants" ("slug")`);

    // regions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "regions" (
        "id"          uuid          NOT NULL,
        "tenantId"    uuid          NOT NULL,
        "regionId"    uuid          NOT NULL,
        "createdAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "isDeleted"   boolean       NOT NULL DEFAULT false,
        "name"        character varying NOT NULL,
        "countryCode" character varying(3) NOT NULL,
        "timezone"    character varying NOT NULL DEFAULT 'Asia/Kolkata',
        "config"      jsonb         NOT NULL DEFAULT '{}',
        "isActive"    boolean       NOT NULL DEFAULT true,
        CONSTRAINT "PK_regions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_regions_tenant_name" ON "regions" ("tenantId", "name")`);

    // users
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id"           uuid          NOT NULL,
        "tenantId"     uuid          NOT NULL,
        "regionId"     uuid          NOT NULL,
        "createdAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "isDeleted"    boolean       NOT NULL DEFAULT false,
        "name"         character varying NOT NULL,
        "email"        character varying NOT NULL,
        "phone"        character varying NOT NULL,
        "passwordHash" character varying NOT NULL,
        "role"         "users_role_enum" NOT NULL,
        "isActive"     boolean       NOT NULL DEFAULT true,
        "lastLoginAt"  TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_tenant_email" ON "users" ("tenantId", "email")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_tenant_phone" ON "users" ("tenantId", "phone")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_users_tenant_region" ON "users" ("tenantId", "regionId")`);

    // riders
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "riders" (
        "id"         uuid          NOT NULL,
        "tenantId"   uuid          NOT NULL,
        "regionId"   uuid          NOT NULL,
        "createdAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "isDeleted"  boolean       NOT NULL DEFAULT false,
        "userId"     uuid          NOT NULL,
        "name"       character varying NOT NULL,
        "email"      character varying NOT NULL,
        "phone"      character varying NOT NULL,
        "rating"     numeric(3,2)  NOT NULL DEFAULT 5.00,
        "totalRides" integer       NOT NULL DEFAULT 0,
        "preferences" jsonb        NOT NULL DEFAULT '{"defaultVehicleType":"ECONOMY","defaultPaymentMethodId":null}',
        CONSTRAINT "PK_riders" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_riders_tenant_user" ON "riders" ("tenantId", "userId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_riders_tenant_region" ON "riders" ("tenantId", "regionId")`);

    // rider_payment_methods
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rider_payment_methods" (
        "id"            uuid          NOT NULL,
        "tenantId"      uuid          NOT NULL,
        "regionId"      uuid          NOT NULL,
        "createdAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "isDeleted"     boolean       NOT NULL DEFAULT false,
        "riderId"       uuid          NOT NULL,
        "type"          "rider_payment_methods_type_enum" NOT NULL,
        "provider"      character varying,
        "maskedDetails" character varying,
        "isDefault"     boolean       NOT NULL DEFAULT false,
        CONSTRAINT "PK_rider_payment_methods" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_rpm_tenant_rider" ON "rider_payment_methods" ("tenantId", "riderId")`);

    // drivers
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "drivers" (
        "id"                    uuid          NOT NULL,
        "tenantId"              uuid          NOT NULL,
        "regionId"              uuid          NOT NULL,
        "createdAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"             TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "isDeleted"             boolean       NOT NULL DEFAULT false,
        "userId"                uuid          NOT NULL,
        "name"                  character varying NOT NULL,
        "email"                 character varying NOT NULL,
        "phone"                 character varying NOT NULL,
        "status"                "drivers_status_enum" NOT NULL DEFAULT 'OFFLINE',
        "rating"                numeric(3,2)  NOT NULL DEFAULT 5.00,
        "totalTrips"            integer       NOT NULL DEFAULT 0,
        "activeVehicleId"       uuid,
        "lastLocationLat"       numeric(10,7),
        "lastLocationLng"       numeric(10,7),
        "lastLocationUpdatedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_drivers" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_drivers_tenant_user" ON "drivers" ("tenantId", "userId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_drivers_tenant_region" ON "drivers" ("tenantId", "regionId")`);

    // vehicles
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "vehicles" (
        "id"           uuid          NOT NULL,
        "tenantId"     uuid          NOT NULL,
        "regionId"     uuid          NOT NULL,
        "createdAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "isDeleted"    boolean       NOT NULL DEFAULT false,
        "driverId"     uuid          NOT NULL,
        "make"         character varying NOT NULL,
        "model"        character varying NOT NULL,
        "year"         integer       NOT NULL,
        "licensePlate" character varying NOT NULL,
        "type"         "vehicles_type_enum" NOT NULL,
        "color"        character varying,
        "isActive"     boolean       NOT NULL DEFAULT true,
        CONSTRAINT "PK_vehicles" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_vehicles_tenant_plate" ON "vehicles" ("tenantId", "licensePlate")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_vehicles_tenant_driver" ON "vehicles" ("tenantId", "driverId")`);

    // rides
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "rides" (
        "id"               uuid          NOT NULL,
        "tenantId"         uuid          NOT NULL,
        "regionId"         uuid          NOT NULL,
        "createdAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "isDeleted"        boolean       NOT NULL DEFAULT false,
        "riderId"          uuid          NOT NULL,
        "driverId"         uuid,
        "status"           "rides_status_enum" NOT NULL DEFAULT 'REQUESTED',
        "pickupLat"        numeric(10,7) NOT NULL,
        "pickupLng"        numeric(10,7) NOT NULL,
        "pickupAddress"    character varying NOT NULL,
        "dropLat"          numeric(10,7) NOT NULL,
        "dropLng"          numeric(10,7) NOT NULL,
        "dropAddress"      character varying NOT NULL,
        "vehicleType"      "rides_vehicletype_enum" NOT NULL DEFAULT 'ECONOMY',
        "fareEstimate"     numeric(10,2) NOT NULL,
        "surgeMultiplier"  numeric(4,2)  NOT NULL DEFAULT 1.00,
        "cancellationReason" character varying,
        "idempotencyKey"   character varying NOT NULL,
        CONSTRAINT "PK_rides" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_rides_tenant_rider" ON "rides" ("tenantId", "riderId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_rides_tenant_region" ON "rides" ("tenantId", "regionId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_rides_tenant_idempotency" ON "rides" ("tenantId", "idempotencyKey")`);

    // trips
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "trips" (
        "id"               uuid          NOT NULL,
        "tenantId"         uuid          NOT NULL,
        "regionId"         uuid          NOT NULL,
        "createdAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "isDeleted"        boolean       NOT NULL DEFAULT false,
        "rideId"           uuid          NOT NULL,
        "driverId"         uuid          NOT NULL,
        "riderId"          uuid          NOT NULL,
        "status"           "trips_status_enum" NOT NULL DEFAULT 'DRIVER_ASSIGNED',
        "startedAt"        TIMESTAMP WITH TIME ZONE,
        "completedAt"      TIMESTAMP WITH TIME ZONE,
        "durationSecs"     integer,
        "distanceKm"       numeric(8,3),
        "finalFare"        numeric(10,2),
        "cancellationReason" character varying,
        "cancellationFee"  numeric(10,2),
        "paymentStatus"    "trips_paymentstatus_enum" NOT NULL DEFAULT 'PENDING',
        CONSTRAINT "PK_trips" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_trips_tenant_ride" ON "trips" ("tenantId", "rideId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trips_tenant_driver" ON "trips" ("tenantId", "driverId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trips_tenant_rider" ON "trips" ("tenantId", "riderId")`);

    // trip_events
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "trip_events" (
        "id"         uuid          NOT NULL,
        "tenantId"   uuid          NOT NULL,
        "regionId"   uuid          NOT NULL,
        "createdAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "isDeleted"  boolean       NOT NULL DEFAULT false,
        "tripId"     uuid          NOT NULL,
        "fromStatus" "trip_events_fromstatus_enum",
        "toStatus"   "trip_events_tostatus_enum" NOT NULL,
        "actorId"    uuid          NOT NULL,
        "actorRole"  character varying NOT NULL,
        "metadata"   jsonb         NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_trip_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_trip_events_trip" ON "trip_events" ("tripId")`);

    // payments
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payments" (
        "id"             uuid          NOT NULL,
        "tenantId"       uuid          NOT NULL,
        "regionId"       uuid          NOT NULL,
        "createdAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "isDeleted"      boolean       NOT NULL DEFAULT false,
        "tripId"         uuid          NOT NULL,
        "riderId"        uuid          NOT NULL,
        "amount"         numeric(10,2) NOT NULL,
        "currency"       character varying NOT NULL DEFAULT 'INR',
        "status"         "payments_status_enum" NOT NULL DEFAULT 'PENDING',
        "pspReference"   character varying,
        "failureReason"  character varying,
        "idempotencyKey" character varying NOT NULL,
        "processedAt"    TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_payments" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_payments_tenant_trip" ON "payments" ("tenantId", "tripId")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payments_tenant_idempotency" ON "payments" ("tenantId", "idempotencyKey")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "payments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "trip_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "trips"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rides"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "vehicles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "drivers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "rider_payment_methods"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "riders"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "regions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "tenants"`);

    await queryRunner.query(`DROP TYPE IF EXISTS "payments_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "trip_events_tostatus_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "trip_events_fromstatus_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "trips_paymentstatus_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "trips_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "rides_vehicletype_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "rides_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "rider_payment_methods_type_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "vehicles_type_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "drivers_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "users_role_enum"`);
  }
}
