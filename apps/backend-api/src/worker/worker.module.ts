import { Module } from '@nestjs/common';

import { EmailProcessor } from './email.processor';
import { CoreModule } from '../common/core/core.module';
import { MailModule } from '../common/mail/mail.module';
import { QueueModule } from '../common/queue/queue.module';
import { RealtimeModule } from '../common/realtime/realtime.module';
import { StorageModule } from '../common/storage/storage.module';
import { DatabaseModule } from '../database/database.module';
import { PasswordResetLinks } from '../modules/auth/password-reset-links';
import { VerificationLinks } from '../modules/auth/verification-links';
import { DocumentScan } from '../modules/documents/document-scan';
import { ClamavScanner } from '../modules/documents/upload/clamav-scanner';
import { OcrProcessor } from '../modules/documents/workers/ocr.processor';
import { NotificationProcessor } from '../modules/notifications/workers/notification.processor';
import { ReminderDelivery } from '../modules/sessions/reminder-delivery';
import { ReminderScheduler } from '../modules/sessions/reminder-scheduler';
import { ReminderProcessor } from '../modules/sessions/workers/reminder.processor';

/**
 * Root module of the worker process (D-011). Processors (`TenantProcessor` subclasses) are registered only here, so
 * only this process consumes jobs; feature modules export them for this module to provide.
 */
@Module({
  imports: [CoreModule, DatabaseModule, QueueModule, RealtimeModule, StorageModule, MailModule],
  providers: [
    EmailProcessor,
    VerificationLinks,
    PasswordResetLinks,
    NotificationProcessor,
    ReminderProcessor,
    ReminderDelivery,
    ReminderScheduler,
    OcrProcessor,
    DocumentScan,
    ClamavScanner,
  ],
})
export class WorkerModule {}
