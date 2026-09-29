import { Global, Module } from '@nestjs/common';

import { ConfigModule } from '../../config/config.module';
import { ReadinessRegistry } from '../../health/readiness.registry';
import { ContextModule } from '../context/context.module';
import { LoggerModule } from '../logging/logger.module';

/**
 * Cross-cutting plumbing shared by the HTTP API and the worker: typed config, CLS request context, Pino, and the
 * readiness registry that infrastructure modules (Prisma, Redis, storage) register their checks with.
 */
@Global()
@Module({
  imports: [ConfigModule, ContextModule, LoggerModule],
  providers: [ReadinessRegistry],
  exports: [ConfigModule, ContextModule, LoggerModule, ReadinessRegistry],
})
export class CoreModule {}
