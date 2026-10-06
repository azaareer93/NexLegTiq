/**
 * Minimal valid environment for tests: only the variables that have no default. Also forced into process.env by
 * jest.setup.ts. Production-grade (TLS URLs, non-placeholder credentials) because an unset NODE_ENV means production.
 * Nothing connects to these hosts; tests spread overrides on top.
 */
export const REQUIRED_TEST_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL:
    'postgresql://nexlegtiq:unit-test-only@localhost:5432/nexlegtiq_test?sslmode=require',
  REDIS_URL: 'rediss://localhost:6379',
  S3_ENDPOINT: 'https://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'nexlegtiq-documents-local',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  JWT_SECRET: 'unit-test-only-jwt-secret-0123456789abcdef',
  TRUST_PROXY_HOPS: '1',
  OFFICE_APP_URL: 'https://app.nexlegtiq.test',
  SMTP_HOST: 'localhost',
  MAIL_FROM: 'no-reply@nexlegtiq.test',
  CLAMAV_HOST: 'localhost',
};

export function testEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { ...REQUIRED_TEST_ENV, ...overrides };
}

/**
 * Integration tests: the real PostgreSQL and Redis from the environment (local dev stack or CI services), and the dev
 * stack's object storage and mail server at fixed IPv4 addresses (docker/compose.dev.yml; CI runs the same containers with
 * the same credentials). Fixed, not read from the environment: Nx loads the developer's `.env` into tasks, and `localhost`
 * resolves to ::1 on Windows while the stack binds 127.0.0.1 only. Metrics are off: several apps in one run would all bind
 * the metrics port.
 */
export function integrationEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return testEnv({
    DATABASE_URL: process.env['DATABASE_URL'],
    REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
    S3_ENDPOINT: 'http://127.0.0.1:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'nexlegtiq-documents-local',
    S3_ACCESS_KEY_ID: 'nexlegtiq',
    S3_SECRET_ACCESS_KEY: 'nexlegtiq-dev-only',
    S3_FORCE_PATH_STYLE: 'true',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
    SMTP_REQUIRE_TLS: 'false',
    NODE_ENV: 'test',
    METRICS_ENABLED: 'false',
    ...overrides,
  });
}
