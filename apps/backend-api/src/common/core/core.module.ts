import { Global, Module } from '@nestjs/common';

import { ConfigModule } from '../../config/config.module';
import { ContextModule } from '../context/context.module';
import { LoggerModule } from '../logging/logger.module';

/** Cross-cutting plumbing shared by the HTTP API and the worker: typed config, CLS request context, Pino. */
@Global()
@Module({
  imports: [ConfigModule, ContextModule, LoggerModule],
  exports: [ConfigModule, ContextModule, LoggerModule],
})
export class CoreModule {}
