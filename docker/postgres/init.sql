-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Ensure UTC timezone for all connections
ALTER DATABASE gocomet_rides SET timezone TO 'UTC';
