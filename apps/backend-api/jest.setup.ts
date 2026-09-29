// Deterministic env for unit/integration tests. Forced (not defaulted) because suites assert on these values;
// a developer's shell or .env must not change results. Individual suites may override and restore.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';
process.env.METRICS_ENABLED = 'false';
process.env.SWAGGER_ENABLED = 'true';
process.env.CORS_ORIGINS = 'http://localhost:4200,http://localhost:4201,http://localhost:4202';
process.env.TRUST_PROXY_HOPS = '0';
// Backing services (no defaults in env.schema.ts). Unit tests never connect; values match src/config/env.fixture.ts.
process.env.DATABASE_URL = 'postgresql://nexlegtiq:nexlegtiq@localhost:5432/nexlegtiq';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_REGION = 'us-east-1';
process.env.S3_BUCKET = 'nexlegtiq-documents-local';
process.env.S3_ACCESS_KEY_ID = 'test-access-key';
process.env.S3_SECRET_ACCESS_KEY = 'test-secret-key';
process.env.SMTP_HOST = 'localhost';
process.env.MAIL_FROM = 'no-reply@nexlegtiq.test';
process.env.CLAMAV_HOST = 'localhost';
