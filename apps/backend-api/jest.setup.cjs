// Deterministic env for unit/integration tests. Forced (not defaulted) because suites assert on these values;
// a developer's shell or .env must not change results. Individual suites may override and restore.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';
process.env.METRICS_ENABLED = 'false';
process.env.SWAGGER_ENABLED = 'true';
process.env.CORS_ORIGINS = 'http://localhost:4200,http://localhost:4201,http://localhost:4202';
process.env.TRUST_PROXY_HOPS = '0';
