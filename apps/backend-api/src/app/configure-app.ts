import type { NestExpressApplication } from '@nestjs/platform-express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
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

  app.set('trust proxy', config.http.trustProxyHops);
  app.use(clsMiddleware());
  // First after CLS so every request is measured, including CORS preflights and body-parser rejections.
  app.use(app.get(MetricsService).middleware);
  app.use(helmet());
  // Reads the httpOnly refresh cookie on /api/v1/auth (D-050); unsigned: the value is an opaque, hashed-at-rest token.
  app.use(cookieParser());
  app.enableCors({
    origin: [...config.corsOrigins],
    // Refresh-token cookie (D-050); CSRF defence for cookie endpoints lives with auth (D-055).
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER],
  });
  app.use(compression());
  // JSON-only API: no urlencoded parser (avoids qs nested-object parsing).
  app.useBodyParser('json', { limit: BODY_LIMIT });

  app.setGlobalPrefix(API_PREFIX, { exclude: UNPREFIXED_ROUTES });
  if (config.swaggerEnabled) setupSwagger(app);
  app.enableShutdownHooks();
}
