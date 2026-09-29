import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65_535);
const csv = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);

/**
 * Environment contract of backend-api (HTTP + worker). Boot fails on invalid env. Unknown keys are ignored.
 * Every variable here must also be documented in `.env.example`. MVP-30 adds DB/Redis/storage variables.
 */
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().trim().min(1).default('localhost'),
    PORT: port.default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    LOG_PRETTY: z.stringbool().default(false),
    CORS_ORIGINS: csv
      .pipe(z.array(z.url()))
      .default(['http://localhost:4200', 'http://localhost:4201', 'http://localhost:4202']),
    SWAGGER_ENABLED: z.stringbool().optional(),
    METRICS_ENABLED: z.stringbool().default(true),
    METRICS_HOST: z.string().trim().min(1).default('localhost'),
    METRICS_PORT: port.default(9464),
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
