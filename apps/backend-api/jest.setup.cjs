// Quiet, side-effect-free defaults for unit/integration tests; individual tests may override.
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.METRICS_ENABLED ??= 'false';
