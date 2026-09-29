import { Global, Module } from '@nestjs/common';

import { HealthController } from './health.controller';
import { ReadinessRegistry } from './readiness.registry';

/** Global so infrastructure modules can inject ReadinessRegistry and register their check. */
@Global()
@Module({
  controllers: [HealthController],
  providers: [ReadinessRegistry],
  exports: [ReadinessRegistry],
})
export class HealthModule {}
