import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';

import { API_PREFIX } from '../bootstrap';

export const BODY_LIMIT = '1mb';

/**
 * Applies HTTP-level setup to an app created from AppModule. Used by `main.ts` and by the integration tests, so tests
 * exercise the real wiring. The app must be created with `{ bodyParser: false, bufferLogs: true }`.
 */
export function configureApp(app: NestExpressApplication): void {
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: true });
  app.enableShutdownHooks();
}
