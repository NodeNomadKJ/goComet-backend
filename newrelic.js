'use strict';

exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  logging: { level: 'warn' },
  allow_all_headers: true,
  distributed_tracing: { enabled: true },
  transaction_tracer: {
    enabled: true,
    transaction_threshold: 0.2,
    record_sql: 'obfuscated',
  },
  slow_sql: { enabled: true },
  error_collector: {
    enabled: true,
    ignore_status_codes: [401, 403, 404],
  },
  custom_attributes: { enabled: true },
};
