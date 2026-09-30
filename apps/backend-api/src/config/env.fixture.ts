/**
 * Minimal valid environment for tests: only the variables that have no default. Also forced into process.env by
 * jest.setup.ts. Production-grade (TLS URLs, non-placeholder credentials) because an unset NODE_ENV means production.
 * Nothing connects to these hosts; tests spread overrides on top.
 */
export const REQUIRED_TEST_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgresql://nexlegtiq:unit-test-only@localhost:5432/nexlegtiq_test?sslmode=require',
  REDIS_URL: 'rediss://localhost:6379',
  S3_ENDPOINT: 'https://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'nexlegtiq-documents-local',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  SMTP_HOST: 'localhost',
  MAIL_FROM: 'no-reply@nexlegtiq.test',
  CLAMAV_HOST: 'localhost',
};

export function testEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...REQUIRED_TEST_ENV, ...overrides };
}
