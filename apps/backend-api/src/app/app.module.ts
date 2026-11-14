import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { CoreModule } from '../common/core/core.module';
import { GlobalExceptionFilter } from '../common/errors/global-exception.filter';
import { EnvelopeInterceptor } from '../common/http/envelope.interceptor';
import { MailModule } from '../common/mail/mail.module';
import { QueueModule } from '../common/queue/queue.module';
import { PermissionsGuard } from '../common/rbac/permissions.guard';
import { RealtimeGatewayModule, RealtimeModule } from '../common/realtime/realtime.module';
import { StorageModule } from '../common/storage/storage.module';
import { TenantInterceptor } from '../common/tenancy/tenant.interceptor';
import { DatabaseModule } from '../database/database.module';
import { HealthModule } from '../health/health.module';
import { MetricsModule } from '../metrics/metrics.module';
import { AiModule } from '../modules/ai/ai.module';
import { AiSummariesModule } from '../modules/ai-summaries/ai-summaries.module';
import { AuthModule } from '../modules/auth/auth.module';
import { JwtAuthGuard } from '../modules/auth/jwt-auth.guard';
import { ClientsModule } from '../modules/clients/clients.module';
import { CourtsModule } from '../modules/courts/courts.module';
import { DashboardModule } from '../modules/dashboard/dashboard.module';
import { DocumentsModule } from '../modules/documents/documents.module';
import { FileParticipantsModule } from '../modules/file-participants/file-participants.module';
import { InvoicesModule } from '../modules/invoices/invoices.module';
import { LegalFilesModule } from '../modules/legal-files/legal-files.module';
import { NotesModule } from '../modules/notes/notes.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { OfficesModule } from '../modules/offices/offices.module';
import { PartiesModule } from '../modules/parties/parties.module';
import { PlatformAuthModule } from '../modules/platform-auth/platform-auth.module';
import { PlatformOfficesModule } from '../modules/platform-offices/platform-offices.module';
import { PlatformPlansModule } from '../modules/platform-plans/platform-plans.module';
import { PortalAuthModule } from '../modules/portal-auth/portal-auth.module';
import { SearchModule } from '../modules/search/search.module';
import { SessionsModule } from '../modules/sessions/sessions.module';
import { SubscriptionGuard } from '../modules/subscriptions/subscription.guard';
import { SubscriptionsModule } from '../modules/subscriptions/subscriptions.module';
import { TasksModule } from '../modules/tasks/tasks.module';
import { TimeEntriesModule } from '../modules/time-entries/time-entries.module';
import { TimelineModule } from '../modules/timeline/timeline.module';
import { UsersModule } from '../modules/users/users.module';
import { WitnessesModule } from '../modules/witnesses/witnesses.module';

/** Root module of the HTTP API. */
@Module({
  imports: [
    CoreModule,
    DatabaseModule,
    // Producers only: the HTTP app enqueues, the worker process consumes (D-011).
    QueueModule,
    RealtimeModule,
    RealtimeGatewayModule,
    StorageModule,
    MailModule,
    HealthModule,
    MetricsModule,
    AuthModule,
    PlatformAuthModule,
    PlatformOfficesModule,
    PlatformPlansModule,
    PortalAuthModule,
    SubscriptionsModule,
    NotificationsModule,
    TimelineModule,
    DashboardModule,
    SearchModule,
    TimeEntriesModule,
    InvoicesModule,
    NotesModule,
    WitnessesModule,
    AiModule,
    AiSummariesModule,
    ClientsModule,
    CourtsModule,
    LegalFilesModule,
    OfficesModule,
    SessionsModule,
    DocumentsModule,
    TasksModule,
    PartiesModule,
    FileParticipantsModule,
    UsersModule,
    // Default 100 requests/min per IP (api-conventions.md); auth routes set stricter limits with @Throttle.
    // ponytail: counters live in process memory, fine for one API container (D-020); move to Redis storage when a
    // second API instance runs.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
  ],
  providers: [
    // Guards run in registration order: rate limit (also for unauthenticated callers), authentication
    // (deny-by-default, @Public() opts out), permissions, then plan features and read-only mode (D-122).
    // useExisting (like JwtAuthGuard) so tests can replace the guard with overrideProvider.
    ThrottlerGuard,
    { provide: APP_GUARD, useExisting: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useExisting: SubscriptionGuard },
    // First: fills CLS (officeId, userId, …) from req.user before anything reads it.
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
