import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

import { getQueue, QUEUE_NAMES } from './queues';

export const BULL_BOARD_PATH = '/admin/queues';

/**
 * Bull Board UI at `/admin/queues` (outside `/api/v1`; architecture.md). Plain Express middleware, so Nest guards never
 * see it: it is mounted only when `BULL_BOARD_ENABLED` is on, which the env schema refuses in production until the
 * platform-admin realm can guard it (D-084). Locally the API binds to 127.0.0.1. Helmet's headers apply here too, except
 * the API's strict CSP, which would block the dashboard's own scripts.
 */
export function mountBullBoard(app: NestExpressApplication): void {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);
  createBullBoard({
    queues: QUEUE_NAMES.map((name) => new BullMQAdapter(getQueue(app, name))),
    serverAdapter,
  });
  app.use(BULL_BOARD_PATH, helmet({ contentSecurityPolicy: false }), serverAdapter.getRouter());
}
