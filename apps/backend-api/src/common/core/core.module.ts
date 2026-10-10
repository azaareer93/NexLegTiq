import { Global, Module } from '@nestjs/common';

import { ConfigModule } from '../../config/config.module';
import { ReadinessRegistry } from '../../health/readiness.registry';
import { ContextModule } from '../context/context.module';
import { FieldCipher } from '../crypto/field-cipher';
import { LoggerModule } from '../logging/logger.module';

/**
 * Cross-cutting plumbing shared by the HTTP API and the worker: typed config, CLS request context, Pino, the field
 * cipher (D-056) and the
 * readiness registry that infrastructure modules (Prisma, Redis, storage) register their checks with.
 */
@Global()
@Module({
  imports: [ConfigModule, ContextModule, LoggerModule],
  providers: [ReadinessRegistry, FieldCipher],
  exports: [ConfigModule, ContextModule, LoggerModule, ReadinessRegistry, FieldCipher],
})
export class CoreModule {}
