import { Module } from '@nestjs/common';

import { CoreModule } from '../common/core/core.module';
import { QueueModule } from '../common/queue/queue.module';
import { DatabaseModule } from '../database/database.module';

/**
 * Root module of the worker process (D-011). Processors (`TenantProcessor` subclasses) are registered only here, so
 * only this process consumes jobs; feature modules export them for this module to provide.
 */
@Module({
  imports: [CoreModule, DatabaseModule, QueueModule],
})
export class WorkerModule {}
