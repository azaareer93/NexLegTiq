import { Module } from '@nestjs/common';

import { CoreModule } from '../common/core/core.module';
import { DatabaseModule } from '../database/database.module';

/** Root module of the worker process. Queue processors are registered here by the queue story (MVP-34). */
@Module({
  imports: [CoreModule, DatabaseModule],
})
export class WorkerModule {}
