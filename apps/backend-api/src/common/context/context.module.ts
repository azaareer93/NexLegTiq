import type { IncomingMessage, ServerResponse } from 'node:http';

import { Global, Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';

import { ensureRequestId } from './request-context';

@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      global: true,
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: IncomingMessage) => ensureRequestId(req),
        // pino-http skips genReqId once `req.id` exists, so the response header is echoed here.
        setup: (_cls, req: IncomingMessage, res: ServerResponse) => {
          ensureRequestId(req, res);
        },
      },
    }),
  ],
})
export class ContextModule {}
