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

/**
 * Environment contract of backend-api (HTTP + worker). Boot fails on invalid env. Unknown keys are ignored.
 * Every variable here must also be documented in `.env.example`. Backing services have no defaults (fail closed):
 * locally they come from `.env` (copy of `.env.example`, matching `docker/compose.dev.yml`), in CI from the workflow.
 */
export const EnvSchema = z
  .object({
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
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    // Prefix of every BullMQ key (D-011), so environments can share a Redis without clashing.
    BULLMQ_PREFIX: z.string().regex(/^[a-z0-9-]{1,32}$/).default('nlq'),

    // S3-compatible object storage (MinIO locally, R2/S3/Spaces elsewhere — D-020).
    S3_ENDPOINT: z.url({ protocol: /^https?$/ }),
    S3_REGION: required,
    S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Invalid bucket name'),
    S3_ACCESS_KEY_ID: required,
    S3_SECRET_ACCESS_KEY: required,
    // MinIO needs path-style URLs; AWS/R2 work with virtual-hosted style.
    S3_FORCE_PATH_STYLE: z.stringbool().default(false),

    SMTP_HOST: required,
    SMTP_PORT: port.default(587),
    // true = implicit TLS (port 465); false = STARTTLS when the server offers it (Mailpit offers none).
    SMTP_SECURE: z.stringbool().default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    MAIL_FROM: z.email(),

    CLAMAV_HOST: required,
    CLAMAV_PORT: port.default(3310),
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.LOG_PRETTY), {
    message: 'LOG_PRETTY must be false in production (pino-pretty is a dev dependency)',
    path: ['LOG_PRETTY'],
  })
  .refine((env) => (env.SMTP_USER === undefined) === (env.SMTP_PASSWORD === undefined), {
    message: 'SMTP_USER and SMTP_PASSWORD must be set together',
    path: ['SMTP_PASSWORD'],
  })
  .transform((env) => ({
    ...env,
    // Swagger defaults to on outside production (api-conventions.md).
    SWAGGER_ENABLED: env.SWAGGER_ENABLED ?? env.NODE_ENV !== 'production',
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
