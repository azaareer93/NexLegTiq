import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65_535);
const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);
// `cors` compares exact origins, so normalise "https://app.example.com/" to "https://app.example.com".
const origin = z.url().transform((url) => new URL(url).origin);
const required = z.string().trim().min(1);
// Connection URLs carry credentials: Zod's URL issues never echo the input, so a bad value is never logged.
const databaseUrl = z.url({ protocol: /^postgres(ql)?$/ });
const redisUrl = z.url({ protocol: /^rediss?$/ });
// Documented dev/CI credentials (compose.dev.yml, .env.example, ci.yml): a production boot with one of them is a mistake.
const PLACEHOLDER_SECRET = /^(nexlegtiq|nexlegtiq-dev-only|ci-only-.*|change-me.*)$/;
const TLS_SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);

/**
 * Environment contract of backend-api (HTTP + worker). Boot fails on invalid env. Unknown keys are ignored.
 * Every variable here must also be documented in `.env.example`. Backing services have no defaults (fail closed):
 * locally they come from `.env` (copy of `.env.example`, matching `docker/compose.dev.yml`), in CI from the workflow.
 */
const EnvObject = z.object({
  // Fail closed: an unset NODE_ENV behaves like production (Swagger off, no pretty logs). .env.example sets development.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  HOST: z.string().trim().min(1).default('localhost'),
  PORT: port.default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z.stringbool().default(false),
  CORS_ORIGINS: csv
    .pipe(z.array(origin))
    .default(['http://localhost:4200', 'http://localhost:4201', 'http://localhost:4202']),
  SWAGGER_ENABLED: z.stringbool().optional(),
  METRICS_ENABLED: z.stringbool().default(true),
  METRICS_HOST: z.string().trim().min(1).default('localhost'),
  METRICS_PORT: port.default(9464),
  // Number of reverse proxies (Caddy/Traefik, D-020) in front of the API whose X-Forwarded-For is trusted. 0 = none.
  // Optional (0) outside production; production must set it, since lockout and rate limits key on the client IP.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),

  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  // Prefix of every BullMQ key (D-011), so environments can share a Redis without clashing.
  BULLMQ_PREFIX: z
    .string()
    .regex(/^[a-z0-9-]{1,32}$/)
    .default('nlq'),

  // S3-compatible object storage (RustFS locally, R2/S3/Spaces elsewhere — D-020, D-078).
  S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
  S3_REGION: required,
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Invalid bucket name'),
  S3_ACCESS_KEY_ID: required,
  S3_SECRET_ACCESS_KEY: required,
  // Local S3 servers need path-style URLs; AWS/R2 work with virtual-hosted style.
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  // Server-side encryption requested on every upload (D-035, D-085). AWS S3 takes AES256; R2 and RustFS encrypt at rest
  // on their own and reject or ignore the header, so they use none.
  S3_SSE: z.enum(['AES256', 'none']).default('none'),

  SMTP_HOST: required,
  SMTP_PORT: port.default(587),
  // true = implicit TLS (port 465); false = STARTTLS on 587.
  SMTP_SECURE: z.stringbool().default(false),
  // Refuse to send when STARTTLS is not offered (stops TLS stripping). Defaults to on in production; Mailpit needs off.
  SMTP_REQUIRE_TLS: z.stringbool().optional(),
  SMTP_USER: required.optional(),
  SMTP_PASSWORD: required.optional(),
  MAIL_FROM: z.email(),
  // Delivery of rendered emails (D-085): smtp (Mailpit locally, any SMTP relay) or the Resend HTTP API.
  EMAIL_PROVIDER: z.enum(['smtp', 'resend']).default('smtp'),
  RESEND_API_KEY: required.optional(),
  // Base URL of the office app, for links in emails (verify email, invitations, password reset).
  OFFICE_APP_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:4200'),

  CLAMAV_HOST: required,
  CLAMAV_PORT: port.default(3310),

  // HS256 key of the office access JWT (auth-rbac.md, Tokens); at least 32 characters of randomness.
  JWT_SECRET: z.string().min(32),
  // AUTH-010 after 7 unverified days, and reclaiming abandoned unverified signups (D-083). Off until verification emails
  // and resend are delivered: with no way to receive the link, enforcing it would lock out every new office.
  EMAIL_VERIFICATION_ENFORCED: z.stringbool().default(false),
  // Bull Board at /admin/queues (D-084). Unauthenticated Express middleware: local debugging only, refused in production.
  BULL_BOARD_ENABLED: z.stringbool().default(false),
});

/** Every variable the backend reads; `.env.example` must document each of them (asserted in env.schema.spec.ts). */
export const ENV_KEYS = Object.keys(EnvObject.shape);

export const EnvSchema = EnvObject.refine((env) => !(env.NODE_ENV === 'production' && env.LOG_PRETTY), {
  message: 'LOG_PRETTY must be false in production (pino-pretty is a dev dependency)',
  path: ['LOG_PRETTY'],
})
  .refine((env) => env.EMAIL_PROVIDER !== 'resend' || env.RESEND_API_KEY !== undefined, {
    message: 'RESEND_API_KEY is required when EMAIL_PROVIDER=resend',
    path: ['RESEND_API_KEY'],
  })
  .refine((env) => (env.SMTP_USER === undefined) === (env.SMTP_PASSWORD === undefined), {
    message: 'SMTP_USER and SMTP_PASSWORD must be set together',
    path: ['SMTP_PASSWORD'],
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    // In transit TLS 1.2+ everywhere (ops-security.md, D-078). Messages never echo values: URLs carry credentials.
    const fail = (path: string, message: string): void => void ctx.addIssue({ code: 'custom', path: [path], message });
    if (!TLS_SSLMODES.has(new URL(env.DATABASE_URL).searchParams.get('sslmode') ?? '')) {
      fail('DATABASE_URL', 'must set sslmode=require, verify-ca or verify-full in production');
    }
    if (!env.REDIS_URL.startsWith('rediss:')) fail('REDIS_URL', 'must use rediss:// (TLS) in production');
    if (!env.S3_ENDPOINT.startsWith('https:')) fail('S3_ENDPOINT', 'must use https:// in production');
    // AWS S3 does not encrypt unless asked (D-035, D-085); R2 and other providers encrypt at rest on their own.
    if (new URL(env.S3_ENDPOINT).hostname.endsWith('.amazonaws.com') && env.S3_SSE !== 'AES256') {
      fail('S3_SSE', 'must be AES256 when storing on AWS S3 in production');
    }
    if (env.TRUST_PROXY_HOPS === undefined || env.TRUST_PROXY_HOPS < 1) {
      // With 0 behind a proxy every client shares the proxy's IP: one attacker would lock out or throttle everyone.
      fail('TRUST_PROXY_HOPS', 'must be set to the number of reverse proxies (>= 1) in production');
    }
    if (!env.OFFICE_APP_URL.startsWith('https:')) fail('OFFICE_APP_URL', 'must use https:// in production (links in emails)');
    if (env.BULL_BOARD_ENABLED) fail('BULL_BOARD_ENABLED', 'must be false in production until platform-admin auth guards it');
    if (env.SMTP_REQUIRE_TLS === false && !env.SMTP_SECURE) {
      fail('SMTP_REQUIRE_TLS', 'must not be false in production unless SMTP_SECURE is true');
    }
    const secrets = {
      DATABASE_URL: decodeURIComponent(new URL(env.DATABASE_URL).password),
      S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
      JWT_SECRET: env.JWT_SECRET,
      SMTP_PASSWORD: env.SMTP_PASSWORD ?? '',
      RESEND_API_KEY: env.RESEND_API_KEY ?? '',
    };
    for (const [key, value] of Object.entries(secrets)) {
      if (PLACEHOLDER_SECRET.test(value)) fail(key, 'uses a documented dev/CI placeholder credential');
    }
  })
  .transform((env) => ({
    ...env,
    // Swagger defaults to on outside production (api-conventions.md).
    SWAGGER_ENABLED: env.SWAGGER_ENABLED ?? env.NODE_ENV !== 'production',
    SMTP_REQUIRE_TLS: env.SMTP_REQUIRE_TLS ?? env.NODE_ENV === 'production',
    TRUST_PROXY_HOPS: env.TRUST_PROXY_HOPS ?? 0,
  }));

export type Env = z.output<typeof EnvSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
