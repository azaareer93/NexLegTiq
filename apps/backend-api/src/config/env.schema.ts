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
  // AES-256-GCM key of the field cipher (D-056, ops-security.md): 32 random bytes as 64 hex characters.
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes written as 64 hexadecimal characters'),
  // AUTH-010 after 7 unverified days, and reclaiming abandoned unverified signups (D-083). Off until verification emails
  // and resend are delivered: with no way to receive the link, enforcing it would lock out every new office.
  EMAIL_VERIFICATION_ENFORCED: z.stringbool().default(false),
  // Bull Board at /admin/queues (D-084). Unauthenticated Express middleware: local debugging only, refused in production.
  BULL_BOARD_ENABLED: z.stringbool().default(false),
});

type RawEnv = z.output<typeof EnvObject>;

/** Production-only checks: [variable, is it broken?, message]. In transit TLS 1.2+ everywhere (ops-security.md, D-078). */
const PRODUCTION_RULES: readonly (readonly [keyof RawEnv, (env: RawEnv) => boolean, string])[] = [
  [
    'DATABASE_URL',
    (env) => !TLS_SSLMODES.has(new URL(env.DATABASE_URL).searchParams.get('sslmode') ?? ''),
    'must set sslmode=require, verify-ca or verify-full in production',
  ],
  [
    'REDIS_URL',
    (env) => !env.REDIS_URL.startsWith('rediss:'),
    'must use rediss:// (TLS) in production',
  ],
  [
    'S3_ENDPOINT',
    (env) => !env.S3_ENDPOINT.startsWith('https:'),
    'must use https:// in production',
  ],
  // AWS S3 does not encrypt unless asked (D-035, D-085); R2 and other providers encrypt at rest on their own.
  [
    'S3_SSE',
    (env) =>
      new URL(env.S3_ENDPOINT).hostname.endsWith('.amazonaws.com') && env.S3_SSE !== 'AES256',
    'must be AES256 when storing on AWS S3 in production',
  ],
  // With 0 behind a proxy every client shares the proxy's IP: one attacker would lock out or throttle everyone.
  [
    'TRUST_PROXY_HOPS',
    (env) => env.TRUST_PROXY_HOPS === undefined || env.TRUST_PROXY_HOPS < 1,
    'must be set to the number of reverse proxies (>= 1) in production',
  ],
  [
    'OFFICE_APP_URL',
    (env) => !env.OFFICE_APP_URL.startsWith('https:'),
    'must use https:// in production (links in emails)',
  ],
  [
    'BULL_BOARD_ENABLED',
    (env) => env.BULL_BOARD_ENABLED,
    'must be false in production until platform-admin auth guards it',
  ],
  // The dev/CI key is one repeated digit (.env.example, ci.yml); a real key never is.
  [
    'ENCRYPTION_KEY',
    (env) => /^(.)\1*$/.test(env.ENCRYPTION_KEY),
    'uses a documented dev/CI placeholder key',
  ],
  [
    'SMTP_REQUIRE_TLS',
    (env) => env.SMTP_REQUIRE_TLS === false && !env.SMTP_SECURE,
    'must not be false in production unless SMTP_SECURE is true',
  ],
];

/** Credentials that must not be the documented dev/CI placeholders in production. */
const secretsOf = (env: RawEnv): Record<string, string> => ({
  DATABASE_URL: decodeURIComponent(new URL(env.DATABASE_URL).password),
  S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
  JWT_SECRET: env.JWT_SECRET,
  SMTP_PASSWORD: env.SMTP_PASSWORD ?? '',
  RESEND_API_KEY: env.RESEND_API_KEY ?? '',
});

/** Every variable the backend reads; `.env.example` must document each of them (asserted in env.schema.spec.ts). */
export const ENV_KEYS = Object.keys(EnvObject.shape);

export const EnvSchema = EnvObject.refine(
  (env) => !(env.NODE_ENV === 'production' && env.LOG_PRETTY),
  {
    message: 'LOG_PRETTY must be false in production (pino-pretty is a dev dependency)',
    path: ['LOG_PRETTY'],
  },
)
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
    // Messages never echo values: URLs carry credentials.
    for (const [path, broken, message] of PRODUCTION_RULES) {
      if (broken(env)) ctx.addIssue({ code: 'custom', path: [path], message });
    }
    for (const [key, value] of Object.entries(secretsOf(env))) {
      if (PLACEHOLDER_SECRET.test(value)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'uses a documented dev/CI placeholder credential',
        });
      }
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
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
