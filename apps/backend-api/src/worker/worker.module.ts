import { Module } from '@nestjs/common';

import { EmailProcessor } from './email.processor';
import { AuditRetentionProcessor } from '../common/audit/audit-retention.processor';
import { CoreModule } from '../common/core/core.module';
import { MailModule } from '../common/mail/mail.module';
import { QueueModule } from '../common/queue/queue.module';
import { RealtimeModule } from '../common/realtime/realtime.module';
import { StorageModule } from '../common/storage/storage.module';
import { DatabaseModule } from '../database/database.module';
import { AiModule } from '../modules/ai/ai.module';
import { AiProcessor } from '../modules/ai/workers/ai.processor';
import { DocumentSummarizer } from '../modules/ai-summaries/document-summarizer';
import { InvitationLinks } from '../modules/auth/invitation-links';
import { PasswordResetLinks } from '../modules/auth/password-reset-links';
import { VerificationLinks } from '../modules/auth/verification-links';
import { DocumentExtraction } from '../modules/documents/document-extraction';
import { DocumentScan } from '../modules/documents/document-scan';
import { ClamavScanner } from '../modules/documents/upload/clamav-scanner';
import { OcrProcessor } from '../modules/documents/workers/ocr.processor';
import { InvoiceOverdueSweep } from '../modules/invoices/invoice-overdue.sweep';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { NotificationProcessor } from '../modules/notifications/workers/notification.processor';
import {
  PortalInvitationLinks,
  PortalPasswordResetLinks,
} from '../modules/portal-auth/portal-links';
import { ReminderDelivery } from '../modules/sessions/reminder-delivery';
import { ReminderScheduler } from '../modules/sessions/reminder-scheduler';
import { ReminderProcessor } from '../modules/sessions/workers/reminder.processor';
import { SubscriptionsModule } from '../modules/subscriptions/subscriptions.module';
import { TimelineModule } from '../modules/timeline/timeline.module';

/**
 * Root module of the worker process (D-011). Processors (`TenantProcessor` subclasses) are registered only here, so
 * only this process consumes jobs; feature modules export them for this module to provide.
 */
@Module({
  imports: [
    CoreModule,
    DatabaseModule,
    QueueModule,
    RealtimeModule,
    StorageModule,
    MailModule,
    SubscriptionsModule,
    NotificationsModule,
    TimelineModule,
    AiModule,
  ],
  providers: [
    EmailProcessor,
    AuditRetentionProcessor,
    InvoiceOverdueSweep,
    VerificationLinks,
    PasswordResetLinks,
    InvitationLinks,
    PortalInvitationLinks,
    PortalPasswordResetLinks,
    NotificationProcessor,
    ReminderProcessor,
    ReminderDelivery,
    ReminderScheduler,
    AiProcessor,
    DocumentSummarizer,
    OcrProcessor,
    DocumentScan,
    DocumentExtraction,
    ClamavScanner,
  ],
})
export class WorkerModule {}
