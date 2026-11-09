import { Module } from '@nestjs/common';

import { TaskAccessService } from './task-access.service';
import { TaskTemplatesController, TaskTemplatesService } from './task-templates.service';
import { TasksController } from './tasks.controller';
import { TasksRepository } from './tasks.repository';
import { TasksService } from './tasks.service';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/** Tasks on legal files and personal tasks (MVP-76, D-098). */
@Module({
  imports: [LegalFilesModule],
  controllers: [TasksController, TaskTemplatesController],
  providers: [TasksService, TaskAccessService, TasksRepository, TaskTemplatesService],
})
export class TasksModule {}
