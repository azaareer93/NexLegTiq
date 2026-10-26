import { Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { AdminAuthGuard, AdminRealmGuard } from './admin-guards';
import { PlatformAuditService } from './platform-audit.service';
import { ADMIN_JWT } from './platform-auth.constants';
import { PlatformAuthController } from './platform-auth.controller';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformSessions } from './platform-sessions';
import { LoginAttemptRepository } from '../auth/login-attempt.repository';
import { PasswordHasher } from '../auth/password-hasher';

/**
 * The platform admin realm (D-145): sign-in with TOTP, sessions, the IP allow-list and the platform audit log. The JWT
 * service (`ADMIN_JWT`, its own token) has no default secret: every admin token is signed and checked with
 * `ADMIN_JWT_SECRET` explicitly, so an office token can never pass. Admin feature modules import this one for its guards and audit service.
 */
@Module({
  controllers: [PlatformAuthController],
  providers: [
    PlatformAuthService,
    PlatformSessions,
    PlatformAuditService,
    AdminRealmGuard,
    AdminAuthGuard,
    PasswordHasher,
    LoginAttemptRepository,
    { provide: ADMIN_JWT, useFactory: () => new JwtService() },
  ],
  exports: [AdminRealmGuard, AdminAuthGuard, PlatformAuditService, PlatformSessions],
})
export class PlatformAuthModule {}
