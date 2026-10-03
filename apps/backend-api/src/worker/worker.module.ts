import { Module } from '@nestjs/common';

import { CoreModule } from '../common/core/core.module';
import { MailModule } from '../common/mail/mail.module';
import { QueueModule } from '../common/queue/queue.module';
import { StorageModule } from '../common/storage/storage.module';
import { VerificationLinks } from '../modules/auth/verification-links';
import { EmailProcessor } from './email.processor';
import { DatabaseModule } from '../database/database.module';

/**
 * Root module of the worker process (D-011). Processors (`TenantProcessor` subclasses) are registered only here, so
 * only this process consumes jobs; feature modules export them for this module to provide.
 */
@Module({
  imports: [CoreModule, DatabaseModule, QueueModule, StorageModule, MailModule],
  providers: [EmailProcessor, VerificationLinks],
})
export class WorkerModule {}
