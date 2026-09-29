import type { IncomingMessage, ServerResponse } from 'node:http';

import { Global, Module } from '@nestjs/common';
import { ClsMiddleware, ClsModule } from 'nestjs-cls';
import type { ClsMiddlewareOptions } from 'nestjs-cls';

import { ensureRequestId } from './request-context';

const CLS_MIDDLEWARE_OPTIONS: ClsMiddlewareOptions = {
  generateId: true,
  idGenerator: (req: IncomingMessage) => ensureRequestId(req),
  // pino-http skips genReqId once `req.id` exists, so the response header is echoed here.
  setup: (_cls, req: IncomingMessage, res: ServerResponse) => {
    ensureRequestId(req, res);
  },
};

/**
 * Express middleware that opens the CLS context for every request. Mounted with `app.use` in configureApp rather
 * than through Nest's middleware consumer, which applies the global prefix and would skip `/health`.
 */
export function clsMiddleware(): ClsMiddleware['use'] {
  return new ClsMiddleware(CLS_MIDDLEWARE_OPTIONS).use;
}

@Global()
@Module({
  imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } })],
})
export class ContextModule {}
