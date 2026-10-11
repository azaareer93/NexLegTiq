import { Module } from '@nestjs/common';

import { ReminderScheduler } from './reminder-scheduler';
import { SessionRemindersService } from './session-reminders.service';
import { SessionWriter } from './session-writer';
import { FileSessionsController, SessionsController } from './sessions.controller';
import { SessionsRepository } from './sessions.repository';
import { SessionsService } from './sessions.service';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/** Hearings: scheduling, conflicts, cancellation, outcomes and the calendar (MVP-67, D-116). */
@Module({
  imports: [LegalFilesModule],
  controllers: [SessionsController, FileSessionsController],
  providers: [
    SessionsService,
    SessionWriter,
    SessionsRepository,
    ReminderScheduler,
    SessionRemindersService,
  ],
  exports: [ReminderScheduler],
})
export class SessionsModule {}
