import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import { v7 as uuidv7 } from 'uuid';

const pool = new Pool({
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  user: process.env.DB_USER ?? 'gocomet',
  password: process.env.DB_PASSWORD ?? 'gocomet_dev',
  database: process.env.DB_NAME ?? 'gocomet_rides',
});

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Clean slate — truncate all seed tables in dependency order
    await client.query(`
      TRUNCATE TABLE
        trip_events,
        payments,
        trips,
        rides,
        rider_payment_methods,
        vehicles,
        drivers,
        riders,
        users,
        regions,
        tenants
      CASCADE
    `);

    const bcryptRounds = parseInt(process.env.BCRYPT_ROUNDS ?? '10', 10);
    const passwordHash = await bcrypt.hash('Test@1234', bcryptRounds);
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);

    // ─── IDs ───────────────────────────────────────────────────────────────
    const tenantId = uuidv7();
    const regionId = uuidv7();

    const adminUserId = uuidv7();
    const rider1UserId = uuidv7();
    const rider2UserId = uuidv7();
    const rider3UserId = uuidv7();
    const driver1UserId = uuidv7();
    const driver2UserId = uuidv7();
    const driver3UserId = uuidv7();
    const driver4UserId = uuidv7();
    const driver5UserId = uuidv7();

    const rider1Id = uuidv7();
    const rider2Id = uuidv7();
    const rider3Id = uuidv7();
    const driver1Id = uuidv7();
    const driver2Id = uuidv7();
    const driver3Id = uuidv7();
    const driver4Id = uuidv7();
    const driver5Id = uuidv7();

    const vehicle1Id = uuidv7();
    const vehicle2Id = uuidv7();
    const vehicle3Id = uuidv7();
    const vehicle4Id = uuidv7();
    const vehicle5Id = uuidv7();

    const rpmId1 = uuidv7();
    const rpmId2 = uuidv7();

    const ride1Id = uuidv7();
    const ride2Id = uuidv7();
    const ride3Id = uuidv7();

    const trip1Id = uuidv7();
    const trip2Id = uuidv7();

    const payment1Id = uuidv7();

    const tripEvent1Id = uuidv7();
    const tripEvent2Id = uuidv7();
    const tripEvent3Id = uuidv7();
    const tripEvent4Id = uuidv7();
    const tripEvent5Id = uuidv7();

    // ─── Tenant ────────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO "tenants" ("id","tenantId","regionId","name","slug","config","plan","isActive")
      VALUES ($1,$1,$2,'GOComet Technologies','gocomet','{}','STANDARD',true)
    `, [tenantId, regionId]);

    // ─── Region ────────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO "regions" ("id","tenantId","regionId","name","countryCode","timezone","config","isActive")
      VALUES ($1,$2,$1,'Bengaluru','IND','Asia/Kolkata','{}',true)
    `, [regionId, tenantId]);

    // ─── Users ─────────────────────────────────────────────────────────────
    const users = [
      [adminUserId,  'Admin User',     'admin@gocomet.com',    '+919999000000', 'ADMIN'],
      [rider1UserId, 'Rahul Sharma',   'rahul@example.com',    '+919876543210', 'RIDER'],
      [rider2UserId, 'Priya Patel',    'priya@example.com',    '+919876543211', 'RIDER'],
      [rider3UserId, 'Amit Kumar',     'amit@example.com',     '+919876543212', 'RIDER'],
      [driver1UserId,'Suresh Yadav',   'suresh@example.com',   '+919876543213', 'DRIVER'],
      [driver2UserId,'Ramesh Singh',   'ramesh@example.com',   '+919876543214', 'DRIVER'],
      [driver3UserId,'Vikram Chauhan', 'vikram@example.com',   '+919876543215', 'DRIVER'],
      [driver4UserId,'Deepak Verma',   'deepak@example.com',   '+919876543216', 'DRIVER'],
      [driver5UserId,'Manoj Kumar',    'manoj@example.com',    '+919876543217', 'DRIVER'],
    ];
    for (const [id, name, email, phone, role] of users) {
      await client.query(`
        INSERT INTO "users" ("id","tenantId","regionId","name","email","phone","passwordHash","role","isActive")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
      `, [id, tenantId, regionId, name, email, phone, passwordHash, role]);
    }

    // ─── Riders ────────────────────────────────────────────────────────────
    const riders = [
      [rider1Id, rider1UserId, 4.80, 12],
      [rider2Id, rider2UserId, 4.95,  7],
      [rider3Id, rider3UserId, 4.50,  3],
    ];
    for (const [id, userId, rating, totalRides] of riders) {
      await client.query(`
        INSERT INTO "riders" ("id","tenantId","regionId","userId","rating","totalRides","preferences")
        VALUES ($1,$2,$3,$4,$5,$6,'{"defaultVehicleType":"ECONOMY","defaultPaymentMethodId":null}')
      `, [id, tenantId, regionId, userId, rating, totalRides]);
    }

    // ─── Rider Payment Methods ─────────────────────────────────────────────
    await client.query(`
      INSERT INTO "rider_payment_methods" ("id","tenantId","regionId","riderId","type","provider","maskedDetails","isDefault")
      VALUES ($1,$2,$3,$4,'UPI','gpay','rahul@gpay',true)
    `, [rpmId1, tenantId, regionId, rider1Id]);
    await client.query(`
      INSERT INTO "rider_payment_methods" ("id","tenantId","regionId","riderId","type","provider","maskedDetails","isDefault")
      VALUES ($1,$2,$3,$4,'CARD','HDFC','****4242',true)
    `, [rpmId2, tenantId, regionId, rider2Id]);

    // ─── Drivers ───────────────────────────────────────────────────────────
    const drivers = [
      // [id, userId, status, rating, totalTrips, activeVehicleId, lat, lng]
      [driver1Id, driver1UserId, 'AVAILABLE', 4.90, 156, vehicle1Id, 12.9352272, 77.6244793],
      [driver2Id, driver2UserId, 'BUSY',      4.75,  98, vehicle2Id, 12.9716,    77.5946],
      [driver3Id, driver3UserId, 'AVAILABLE', 4.85,  74, vehicle3Id, 12.9279,    77.6271],
      [driver4Id, driver4UserId, 'OFFLINE',   4.60,  31, null,       null,       null],
      [driver5Id, driver5UserId, 'OFFLINE',   4.70,  45, null,       null,       null],
    ];
    for (const [id, userId, status, rating, totalTrips, activeVehicleId, lat, lng] of drivers) {
      await client.query(`
        INSERT INTO "drivers" ("id","tenantId","regionId","userId","status","rating","totalTrips","activeVehicleId","lastLocationLat","lastLocationLng","lastLocationUpdatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [id, tenantId, regionId, userId, status, rating, totalTrips,
          activeVehicleId, lat, lng, lat ? now : null]);
    }

    // ─── Vehicles ──────────────────────────────────────────────────────────
    const vehicles = [
      [vehicle1Id, driver1Id, 'Maruti', 'Swift',  2022, 'KA01AB1234', 'ECONOMY', 'White'],
      [vehicle2Id, driver2Id, 'Honda',  'City',   2021, 'KA02CD5678', 'PREMIUM', 'Silver'],
      [vehicle3Id, driver3Id, 'Toyota', 'Innova', 2020, 'KA03EF9012', 'XL',      'Grey'],
      [vehicle4Id, driver4Id, 'Tata',   'Nexon',  2023, 'KA04GH3456', 'ECONOMY', 'Blue'],
      [vehicle5Id, driver5Id, 'Hyundai','i20',    2019, 'KA05IJ7890', 'ECONOMY', 'Red'],
    ];
    for (const [id, driverId, make, model, year, licensePlate, type, color] of vehicles) {
      await client.query(`
        INSERT INTO "vehicles" ("id","tenantId","regionId","driverId","make","model","year","licensePlate","type","color","isActive")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
      `, [id, tenantId, regionId, driverId, make, model, year, licensePlate, type, color]);
    }

    // ─── Rides ─────────────────────────────────────────────────────────────
    // Ride 1: Completed — Koramangala → Whitefield
    await client.query(`
      INSERT INTO "rides" ("id","tenantId","regionId","riderId","driverId","status","pickupLat","pickupLng","pickupAddress","dropLat","dropLng","dropAddress","vehicleType","fareEstimate","surgeMultiplier","idempotencyKey","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,'PAYMENT_COMPLETED',12.9352,77.6245,'14th Cross, Koramangala, Bengaluru',12.9698,77.7499,'Whitefield Main Road, Bengaluru','ECONOMY',320.00,1.00,'idem-ride-001',$6,$7)
    `, [ride1Id, tenantId, regionId, rider1Id, driver1Id, twoHoursAgo, oneHourAgo]);

    // Ride 2: Ongoing — Indiranagar → Electronic City (driver arriving)
    await client.query(`
      INSERT INTO "rides" ("id","tenantId","regionId","riderId","driverId","status","pickupLat","pickupLng","pickupAddress","dropLat","dropLng","dropAddress","vehicleType","fareEstimate","surgeMultiplier","idempotencyKey","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,'DRIVER_ARRIVING',12.9784,77.6408,'100 Feet Road, Indiranagar, Bengaluru',12.8399,77.6770,'Electronic City Phase 1, Bengaluru','PREMIUM',480.00,1.20,'idem-ride-002',$6,$7)
    `, [ride2Id, tenantId, regionId, rider2Id, driver2Id, thirtyMinAgo, now]);

    // Ride 3: Cancelled by rider
    await client.query(`
      INSERT INTO "rides" ("id","tenantId","regionId","riderId","driverId","status","pickupLat","pickupLng","pickupAddress","dropLat","dropLng","dropAddress","vehicleType","fareEstimate","surgeMultiplier","cancellationReason","idempotencyKey","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,NULL,'CANCELLED',12.9279,77.6271,'MG Road, Bengaluru',12.9141,77.6410,'Brigade Road, Bengaluru','ECONOMY',120.00,1.00,'Driver was taking too long','idem-ride-003',$5,$5)
    `, [ride3Id, tenantId, regionId, rider3Id, thirtyMinAgo]);

    // ─── Trips ─────────────────────────────────────────────────────────────
    // Trip 1: Completed
    await client.query(`
      INSERT INTO "trips" ("id","tenantId","regionId","rideId","driverId","riderId","status","startedAt","completedAt","durationSecs","distanceKm","finalFare","paymentStatus","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,'PAYMENT_COMPLETED',$7,$8,2700,14.800,320.00,'COMPLETED',$9,$10)
    `, [trip1Id, tenantId, regionId, ride1Id, driver1Id, rider1Id,
        new Date(twoHoursAgo.getTime() + 5 * 60 * 1000),
        new Date(twoHoursAgo.getTime() + 50 * 60 * 1000),
        twoHoursAgo, oneHourAgo]);

    // Trip 2: Ongoing (driver arriving)
    await client.query(`
      INSERT INTO "trips" ("id","tenantId","regionId","rideId","driverId","riderId","status","paymentStatus","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,'DRIVER_ARRIVING','PENDING',$7,$8)
    `, [trip2Id, tenantId, regionId, ride2Id, driver2Id, rider2Id, thirtyMinAgo, now]);

    // ─── Trip Events ───────────────────────────────────────────────────────
    const tripEvents = [
      [tripEvent1Id, trip1Id, null,               'DRIVER_ASSIGNED',    driver1Id, 'DRIVER',  twoHoursAgo],
      [tripEvent2Id, trip1Id, 'DRIVER_ASSIGNED',  'DRIVER_ARRIVING',    driver1Id, 'DRIVER',  new Date(twoHoursAgo.getTime() + 1*60*1000)],
      [tripEvent3Id, trip1Id, 'DRIVER_ARRIVING',  'DRIVER_ARRIVED',     driver1Id, 'DRIVER',  new Date(twoHoursAgo.getTime() + 4*60*1000)],
      [tripEvent4Id, trip1Id, 'DRIVER_ARRIVED',   'RIDE_STARTED',       driver1Id, 'DRIVER',  new Date(twoHoursAgo.getTime() + 5*60*1000)],
      [tripEvent5Id, trip1Id, 'RIDE_STARTED',     'COMPLETED',          driver1Id, 'DRIVER',  new Date(twoHoursAgo.getTime() + 50*60*1000)],
    ];
    for (const [id, tripId, fromStatus, toStatus, actorId, actorRole, createdAt] of tripEvents) {
      await client.query(`
        INSERT INTO "trip_events" ("id","tenantId","regionId","tripId","fromStatus","toStatus","actorId","actorRole","metadata","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9,$9)
      `, [id, tenantId, regionId, tripId, fromStatus, toStatus, actorId, actorRole, createdAt]);
    }

    // ─── Payments ──────────────────────────────────────────────────────────
    await client.query(`
      INSERT INTO "payments" ("id","tenantId","regionId","tripId","riderId","amount","currency","status","pspReference","idempotencyKey","processedAt","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,320.00,'INR','COMPLETED','PSP-REF-001','pay-idem-001',$6,$7,$8)
    `, [payment1Id, tenantId, regionId, trip1Id, rider1Id,
        new Date(oneHourAgo.getTime() - 5 * 60 * 1000),
        oneHourAgo, oneHourAgo]);

    await client.query('COMMIT');

    console.log('✅ Seed completed successfully');
    console.log(`   Tenant:   ${tenantId}  (slug: gocomet)`);
    console.log(`   Region:   ${regionId}  (Bengaluru)`);
    console.log(`   Users:    9 created (admin@gocomet.com, rahul/priya/amit/suresh/ramesh/vikram/deepak/manoj @example.com)`);
    console.log(`   Password: Test@1234 for all users`);
    console.log(`   Rides:    3 created (1 completed, 1 ongoing, 1 cancelled)`);
    console.log(`   Trips:    2 created (1 completed, 1 in-progress)`);
    console.log(`   Payments: 1 completed for INR 320`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err: unknown) => {
  console.error('Seed failed:', (err as Error).message);
  console.error((err as Error).stack ?? '');
  process.exit(1);
});
