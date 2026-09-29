/**
 * Minimal valid environment for unit tests: only the variables that have no default.
 * Values mirror `docker/compose.dev.yml`; tests spread overrides on top.
 */
export const REQUIRED_TEST_ENV: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgresql://nexlegtiq:nexlegtiq@localhost:5432/nexlegtiq',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
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
