import { REQUIRED_TEST_ENV } from './src/config/env.fixture';

// Deterministic env for unit/integration tests. Forced (not defaulted) because suites assert on these values;
// a developer's shell or .env must not change results. Individual suites may override and restore.
Object.assign(process.env, REQUIRED_TEST_ENV, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  LOG_PRETTY: 'false',
  METRICS_ENABLED: 'false',
  SWAGGER_ENABLED: 'true',
  CORS_ORIGINS: 'http://localhost:4200,http://localhost:4201,http://localhost:4202',
  TRUST_PROXY_HOPS: '0',
});
