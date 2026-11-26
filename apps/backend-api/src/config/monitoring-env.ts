import { z } from 'zod';

/** Prometheus `/metrics` on its own internal port, and error reporting (D-230). */
export const MONITORING_ENV = {
  METRICS_ENABLED: z.stringbool().default(true),
  METRICS_HOST: z.string().trim().min(1).default('localhost'),
  METRICS_PORT: z.coerce.number().int().min(1).max(65_535).default(9464),
  // Off unless a DSN is set (Sentry, EU region).
  SENTRY_DSN: z.url({ protocol: /^https$/ }).optional(),
  // Staging and production both run NODE_ENV=production, so the reported environment has its own variable.
  SENTRY_ENVIRONMENT: z.string().trim().min(1).optional(),
  // The deployed release (image tag or git sha); errors are grouped by it.
  SENTRY_RELEASE: z.string().trim().min(1).optional(),
};
