import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { CoreModule } from '../common/core/core.module';
import { GlobalExceptionFilter } from '../common/errors/global-exception.filter';
import { EnvelopeInterceptor } from '../common/http/envelope.interceptor';
import { MailModule } from '../common/mail/mail.module';
import { QueueModule } from '../common/queue/queue.module';
import { PermissionsGuard } from '../common/rbac/permissions.guard';
import { StorageModule } from '../common/storage/storage.module';
import { TenantInterceptor } from '../common/tenancy/tenant.interceptor';
import { DatabaseModule } from '../database/database.module';
import { HealthModule } from '../health/health.module';
import { MetricsModule } from '../metrics/metrics.module';
import { AuthModule } from '../modules/auth/auth.module';
import { JwtAuthGuard } from '../modules/auth/jwt-auth.guard';
import { LegalFilesModule } from '../modules/legal-files/legal-files.module';

/** Root module of the HTTP API. */
@Module({
  imports: [
    CoreModule,
    DatabaseModule,
    // Producers only: the HTTP app enqueues, the worker process consumes (D-011).
    QueueModule,
    StorageModule,
    MailModule,
    HealthModule,
    MetricsModule,
    AuthModule,
    LegalFilesModule,
    // Default 100 requests/min per IP (api-conventions.md); auth routes set stricter limits with @Throttle.
    // ponytail: counters live in process memory, fine for one API container (D-020); move to Redis storage when a
    // second API instance runs.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
  ],
  providers: [
    // Guards run in registration order: rate limit (also for unauthenticated callers), authentication
    // (deny-by-default, @Public() opts out), then permissions.
    // useExisting (like JwtAuthGuard) so tests can replace the guard with overrideProvider.
    ThrottlerGuard,
    { provide: APP_GUARD, useExisting: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // First: fills CLS (officeId, userId, …) from req.user before anything reads it.
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
