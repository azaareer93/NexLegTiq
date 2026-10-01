import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { CoreModule } from '../common/core/core.module';
import { DatabaseModule } from '../database/database.module';
import { GlobalExceptionFilter } from '../common/errors/global-exception.filter';
import { EnvelopeInterceptor } from '../common/http/envelope.interceptor';
import { PermissionsGuard } from '../common/rbac/permissions.guard';
import { TenantInterceptor } from '../common/tenancy/tenant.interceptor';
import { HealthModule } from '../health/health.module';
import { MetricsModule } from '../metrics/metrics.module';
import { AuthModule } from '../modules/auth/auth.module';
import { JwtAuthGuard } from '../modules/auth/jwt-auth.guard';

/** Root module of the HTTP API. */
@Module({
  imports: [CoreModule, DatabaseModule, HealthModule, MetricsModule, AuthModule],
  providers: [
    // Guards run in registration order: authentication (deny-by-default, @Public() opts out), then permissions.
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // First: fills CLS (officeId, userId, …) from req.user before anything reads it.
    { provide: APP_INTERCEPTOR, useClass: TenantInterceptor },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
