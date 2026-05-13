'use strict';

/**
 * New Relic agent configuration.
 * All values here can be overridden via environment variables.
 * Env vars always take precedence over this file.
 */
exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME ?? 'gocomet-rides-dev'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,

  logging: {
    // 'info' in prod; 'trace' to debug agent startup issues
    level: process.env.NODE_ENV === 'production' ? 'info' : 'info',
    filepath: 'stdout',
  },

  // Distributed tracing — traces requests across services
  distributed_tracing: {
    enabled: true,
  },

  // Capture slow SQL queries (threshold: 500ms to match maxQueryExecutionTime)
  slow_sql: {
    enabled: true,
    max_samples: 10,
  },

  transaction_tracer: {
    enabled: true,
    transaction_threshold: 200, // ms — record transactions slower than 200ms
    record_sql: 'obfuscated',   // log SQL but mask parameter values
    explain_threshold: 500,     // ms — run EXPLAIN on queries slower than 500ms
  },

  // Track external HTTP calls (e.g., to PSP, FCM)
  error_collector: {
    enabled: true,
    ignore_status_codes: [404],
  },

  // Custom attributes added to every transaction
  attributes: {
    enabled: true,
    include: ['request.headers.x-correlation-id', 'request.headers.x-tenant-id'],
  },

  // Enables host/port reporting on DB spans — resolves "1 uninstrumented database" warning
  datastore_tracer: {
    instance_reporting: { enabled: true },
    database_name_reporting: { enabled: true },
  },

  // Node.js-specific settings
  rules: {
    ignore: ['^/health$'],  // don't create transactions for health checks
  },
};
