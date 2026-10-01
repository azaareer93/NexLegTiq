import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect, parseEnv as parseDotenv } from 'node:util';

import { AppConfig } from './app-config';
import { REQUIRED_TEST_ENV, testEnv } from './env.fixture';
import { ENV_KEYS, parseEnv } from './env.schema';

describe('parseEnv', () => {
  it('should apply fail-closed defaults when only the required variables are set', () => {
    const env = parseEnv(testEnv());

    expect(env).toMatchObject({
      NODE_ENV: 'production',
      HOST: 'localhost',
      PORT: 3000,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
      SWAGGER_ENABLED: false,
      METRICS_ENABLED: true,
      METRICS_PORT: 9464,
      TRUST_PROXY_HOPS: 1,
    });
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:4200', 'http://localhost:4201', 'http://localhost:4202']);
  });

  it('should coerce numbers, booleans and comma-separated origins', () => {
    const env = parseEnv(
      testEnv({
        NODE_ENV: 'development',
        PORT: '8080',
        LOG_PRETTY: 'true',
        METRICS_ENABLED: 'false',
        CORS_ORIGINS: 'https://app.example.test, https://portal.example.test',
      }),
    );

    expect(env.PORT).toBe(8080);
    expect(env.LOG_PRETTY).toBe(true);
    expect(env.METRICS_ENABLED).toBe(false);
    expect(env.CORS_ORIGINS).toEqual(['https://app.example.test', 'https://portal.example.test']);
  });

  it('should normalise CORS origins to scheme://host[:port]', () => {
    const env = parseEnv(
      testEnv({
        CORS_ORIGINS: 'https://app.example.test/, http://localhost:4200/path',
      }),
    );

    expect(env.CORS_ORIGINS).toEqual(['https://app.example.test', 'http://localhost:4200']);
  });

  it('should reject LOG_PRETTY in production but allow it elsewhere', () => {
    expect(() => parseEnv(testEnv({ NODE_ENV: 'production', LOG_PRETTY: 'true' }))).toThrow(/LOG_PRETTY/);
    expect(parseEnv(testEnv({ NODE_ENV: 'development', LOG_PRETTY: 'true' })).LOG_PRETTY).toBe(true);
  });

  it('should enable Swagger by default outside production', () => {
    expect(parseEnv(testEnv({ NODE_ENV: 'development' })).SWAGGER_ENABLED).toBe(true);
    expect(parseEnv(testEnv({ NODE_ENV: 'test' })).SWAGGER_ENABLED).toBe(true);
  });

  it('should disable Swagger by default in production but honour an explicit flag', () => {
    expect(parseEnv(testEnv({ NODE_ENV: 'production' })).SWAGGER_ENABLED).toBe(false);
    expect(parseEnv(testEnv({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' })).SWAGGER_ENABLED).toBe(true);
  });

  it('should ignore unknown variables', () => {
    expect(parseEnv(testEnv({ SOMETHING_ELSE: 'x' }))).not.toHaveProperty('SOMETHING_ELSE');
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '70000'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['CORS_ORIGINS', 'not-a-url'],
    ['METRICS_ENABLED', 'maybe'],
    ['TRUST_PROXY_HOPS', '-1'],
    ['TRUST_PROXY_HOPS', '6'],
    ['HOST', '  '],
    ['DATABASE_URL', 'mysql://user:pass@localhost/db'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['BULLMQ_PREFIX', 'Has Spaces'],
    ['S3_ENDPOINT', 'ftp://localhost:9000'],
    ['S3_BUCKET', 'Upper_Case'],
    ['S3_BUCKET', 'ab'],
    ['S3_BUCKET', '-abc'],
    ['S3_REGION', ' '],
    ['S3_SECRET_ACCESS_KEY', ''],
    ['S3_FORCE_PATH_STYLE', 'sometimes'],
    ['SMTP_PORT', '0'],
    ['SMTP_PORT', '65536'],
    ['SMTP_HOST', ''],
    ['SMTP_REQUIRE_TLS', 'perhaps'],
    ['SMTP_USER', ''],
    ['MAIL_FROM', 'not-an-email'],
    ['CLAMAV_PORT', 'clam'],
  ])('should throw naming %s when it is %s', (key, value) => {
    expect(() => parseEnv(testEnv({ [key]: value }))).toThrow(new RegExp(`Invalid environment:[\\s\\S]*${key}`));
  });

  it('should fail fast listing every missing backing-service variable', () => {
    let message = '';
    try {
      parseEnv({});
    } catch (error) {
      message = (error as Error).message;
    }

    // TRUST_PROXY_HOPS is only required in production, checked after the shape (fixture defaults to production).
    for (const key of Object.keys(REQUIRED_TEST_ENV).filter((name) => name !== 'TRUST_PROXY_HOPS')) {
      expect(message).toContain(key);
    }
  });

  it('should never echo a rejected connection URL (it may carry credentials)', () => {
    const secret = 's3cr3t-password';

    expect(() => parseEnv(testEnv({ DATABASE_URL: `mysql://app:${secret}@db/x` }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(secret) }),
    );
  });

  it('should default the optional backing-service settings', () => {
    expect(parseEnv(testEnv())).toMatchObject({
      BULLMQ_PREFIX: 'nlq',
      S3_FORCE_PATH_STYLE: false,
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      SMTP_REQUIRE_TLS: true,
      CLAMAV_PORT: 3310,
    });
    expect(parseEnv(testEnv({ NODE_ENV: 'development' })).SMTP_REQUIRE_TLS).toBe(false);
  });

  it.each([
    ['DATABASE_URL', 'postgresql://app:strong-pw@db:5432/nexlegtiq'],
    ['DATABASE_URL', 'postgresql://app:strong-pw@db:5432/nexlegtiq?sslmode=prefer'],
    ['REDIS_URL', 'redis://cache:6379'],
    ['S3_ENDPOINT', 'http://storage:9000'],
    ['SMTP_REQUIRE_TLS', 'false'],
    ['DATABASE_URL', 'postgresql://nexlegtiq:nexlegtiq@db:5432/nexlegtiq?sslmode=require'],
    ['S3_SECRET_ACCESS_KEY', 'nexlegtiq-dev-only'],
    ['S3_ACCESS_KEY_ID', 'ci-only-access-key'],
    ['TRUST_PROXY_HOPS', '0'],
    ['TRUST_PROXY_HOPS', undefined],
  ])('should reject %s=%s in production (plaintext transport or dev credential)', (key, value) => {
    expect(() => parseEnv(testEnv({ NODE_ENV: 'production', [key]: value }))).toThrow(new RegExp(key));
    expect(() => parseEnv(testEnv({ NODE_ENV: 'development', [key]: value }))).not.toThrow();
  });

  it('should allow SMTP_REQUIRE_TLS=false in production when SMTP_SECURE uses implicit TLS', () => {
    expect(() =>
      parseEnv(
        testEnv({
          NODE_ENV: 'production',
          SMTP_SECURE: 'true',
          SMTP_REQUIRE_TLS: 'false',
        }),
      ),
    ).not.toThrow();
  });

  it('should require SMTP_USER and SMTP_PASSWORD together', () => {
    expect(() => parseEnv(testEnv({ SMTP_USER: 'mailer' }))).toThrow(/SMTP_PASSWORD/);
    expect(() => parseEnv(testEnv({ SMTP_PASSWORD: 'pw' }))).toThrow(/SMTP_PASSWORD/);
    expect(() => parseEnv(testEnv({ SMTP_USER: 'mailer', SMTP_PASSWORD: 'pw' }))).not.toThrow();
  });
});

describe('AppConfig', () => {
  it('should expose grouped, typed settings', () => {
    const config = new AppConfig(
      parseEnv(
        testEnv({
          NODE_ENV: 'production',
          HOST: '0.0.0.0',
          METRICS_PORT: '9100',
        }),
      ),
    );

    expect(config.isProduction).toBe(true);
    expect(config.nodeEnv).toBe('production');
    expect(config.http).toEqual({
      host: '0.0.0.0',
      port: 3000,
      trustProxyHops: 1,
    });
    expect(config.log).toEqual({ level: 'info', pretty: false });
    expect(config.swaggerEnabled).toBe(false);
    expect(config.corsOrigins).toHaveLength(3);
    expect(config.metrics).toEqual({
      enabled: true,
      host: 'localhost',
      port: 9100,
    });
    expect(config.database).toEqual({ url: REQUIRED_TEST_ENV['DATABASE_URL'] });
    expect(config.redis).toEqual({
      url: REQUIRED_TEST_ENV['REDIS_URL'],
      bullmqPrefix: 'nlq',
    });
    expect(config.storage).toEqual({
      endpoint: 'https://localhost:9000',
      region: 'us-east-1',
      bucket: 'nexlegtiq-documents-local',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      forcePathStyle: false,
    });
    expect(config.clamav).toEqual({ host: 'localhost', port: 3310 });
  });

  it('should expose SMTP auth only when credentials are configured', () => {
    const anonymous = new AppConfig(parseEnv(testEnv({ SMTP_PORT: '1025' })));
    const authenticated = new AppConfig(parseEnv(testEnv({ SMTP_USER: 'mailer', SMTP_PASSWORD: 'pw' })));

    expect(anonymous.mail).toEqual({
      host: 'localhost',
      port: 1025,
      secure: false,
      requireTLS: true,
      from: 'no-reply@nexlegtiq.test',
    });
    expect(authenticated.mail.auth).toEqual({ user: 'mailer', pass: 'pw' });
  });

  it('should map non-default storage and mail flags', () => {
    const config = new AppConfig(
      parseEnv(
        testEnv({
          S3_FORCE_PATH_STYLE: 'true',
          SMTP_SECURE: 'true',
          SMTP_PORT: '465',
        }),
      ),
    );

    expect(config.storage.forcePathStyle).toBe(true);
    expect(config.mail).toMatchObject({ secure: true, port: 465 });
  });

  it('should never serialise its secrets', () => {
    const config = new AppConfig(parseEnv(testEnv()));

    expect(JSON.stringify(config)).not.toContain('test-secret-key');
    expect(inspect(config)).not.toContain('test-secret-key');
  });

  it('should accept the committed .env.example as a complete development config', () => {
    const source = readFileSync(join(__dirname, '../../../../.env.example'), 'utf8');
    const example = parseDotenv(source);
    const documented = [...source.matchAll(/^#? *([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);

    expect(parseEnv(example).NODE_ENV).toBe('development');
    expect(documented.sort()).toEqual([...ENV_KEYS].sort());
  });
});
