import { Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { PortalAccessController } from './portal-access.controller';
import { PortalAccessService } from './portal-access.service';
import { PortalAccounts } from './portal-accounts';
import { PORTAL_JWT } from './portal-auth.constants';
import { PortalAuthController } from './portal-auth.controller';
import { PortalAuthService } from './portal-auth.service';
import { PortalAuthGuard, PortalRealmGuard } from './portal-guards';
import { PortalInvitationAcceptService } from './portal-invitation-accept.service';
import { PortalSessions } from './portal-sessions';
import { AuthModule } from '../auth/auth.module';

/**
 * The client-portal realm (D-158): sign-in, invitations, sessions and password reset for portal accounts, plus the
 * office-side routes that invite and revoke them. The JWT service (`PORTAL_JWT`) has no default secret: every portal token
 * is signed and checked with `JWT_PORTAL_SECRET` explicitly, so an office or admin token can never pass. Portal feature
 * modules import this one for `PortalRealmGuard` and `PortalAuthGuard`. The worker provides the link creators itself.
 */
@Module({
  // The office realm's password hashing and login attempts (D-082): one instance each.
  imports: [AuthModule],
  controllers: [PortalAuthController, PortalAccessController],
  providers: [
    PortalAuthService,
    PortalInvitationAcceptService,
    PortalAccessService,
    PortalAccounts,
    PortalSessions,
    PortalRealmGuard,
    PortalAuthGuard,
    { provide: PORTAL_JWT, useFactory: () => new JwtService() },
  ],
  exports: [PortalRealmGuard, PortalAuthGuard, PortalAccounts, PortalSessions],
})
export class PortalAuthModule {}
