import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { API_PREFIX } from '../bootstrap';
import { clsMiddleware } from '../common/context/context.module';
import { REQUEST_ID_HEADER } from '../common/context/request-context';
import { setupSwagger } from '../common/openapi/swagger';
import { AppConfig } from '../config/app-config';
import { MetricsService } from '../metrics/metrics.service';

export const BODY_LIMIT = '1mb';

/** Routes served outside `/api/v1` (probes must not depend on the API version). */
export const UNPREFIXED_ROUTES = ['health', 'health/ready'];

/**
 * Applies HTTP-level setup to an app created from AppModule. Used by `main.ts` and by the integration tests, so tests
 * exercise the real wiring. The app must be created with `{ bodyParser: false, bufferLogs: true }`.
 */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get(AppConfig);
  app.useLogger(app.get(Logger));

  app.use(clsMiddleware());
  app.use(helmet());
  app.enableCors({
    origin: [...config.corsOrigins],
    // Refresh-token cookie (D-050); CSRF defence for cookie endpoints lives with auth (D-055).
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER],
  });
  app.use(compression());
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });
  app.use(app.get(MetricsService).middleware);

  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });
  if (config.swaggerEnabled) setupSwagger(app);
  app.enableShutdownHooks();
}
