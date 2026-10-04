import { Injectable } from '@nestjs/common';
import { passwordIsNotEmail } from '@nexlegtiq/shared-contracts';
import type { ChangePasswordRequest, ForgotPasswordRequest, ResetPasswordRequest } from '@nexlegtiq/shared-contracts';

import { hashOpaqueToken } from '../../common/auth/opaque-token';
import type { AuthPrincipal } from '../../common/context/request-context';
import { AppException, ValidationException } from '../../common/errors/app.exception';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { AccountMailer } from './account-mailer';
import { tenantContextFor } from './client-info';
import type { ClientInfo } from './client-info';
import { PasswordHasher } from './password-hasher';
import { PasswordRepository } from './password.repository';

const INVALID_LINK = 'Reset link is invalid or has expired';

/**
 * Forgot / reset / change password (MVP-41, auth-rbac.md Flows, D-086). Reset links are created and emailed by the worker
 * (PasswordResetLinks), so this service never handles a raw link it did not receive from the user.
 */
@Injectable()
export class PasswordService {
  constructor(
    private readonly passwords: PasswordHasher,
    private readonly accounts: PasswordRepository,
    private readonly tenant: TenantRunner,
    private readonly mailer: AccountMailer,
  ) {}

  /**
   * Always succeeds, whether or not the email has an account (anti-enumeration). For an active user of an active office
   * the worker is asked for a reset email — without waiting, so both answers take the same time.
   */
  async forgotPassword(body: ForgotPasswordRequest, client: ClientInfo): Promise<void> {
    const account = await this.accounts.findAccount(body.email);
    if (account?.isActive && account.office.isActive) {
      void this.mailer.sendPasswordReset({ userId: account.id, officeId: account.officeId }, client);
    }
  }

  /** Sets the new password with a valid link. Unknown, used or expired links, and those of a deactivated user or suspended office, get 410 RES-004. */
  async resetPassword(body: ResetPasswordRequest, client: ClientInfo): Promise<void> {
    const now = new Date();
    const link = await this.accounts.findResetLink(hashOpaqueToken(body.token));
    const usable = link && link.usedAt === null && link.expiresAt > now && link.user.isActive && link.user.office.isActive;
    if (!usable) throw new AppException('RES-004', INVALID_LINK);
    if (!passwordIsNotEmail(body.newPassword, link.user.email)) {
      throw new ValidationException([{ field: 'newPassword', message: 'validation.password.sameAsEmail' }]);
    }
    const passwordHash = await this.passwords.hash(body.newPassword);
    const used = await this.tenant.run(tenantContextFor(link.officeId, link.userId, client), () =>
      this.accounts.resetPassword(link, passwordHash, now, client),
    );
    if (!used) throw new AppException('RES-004', INVALID_LINK);
  }

  /**
   * The signed-in user changes their password: the current one must be right (400 VAL-001 on `currentPassword`, not 401,
   * which would make the app try to refresh), and every other session ends — this one stays signed in.
   */
  async changePassword(principal: AuthPrincipal, body: ChangePasswordRequest, client: ClientInfo): Promise<void> {
    const user = await this.accounts.findCredentials(principal.userId);
    if (!user || !(await this.passwords.verify(user.passwordHash, body.currentPassword))) {
      throw new ValidationException([{ field: 'currentPassword', message: 'validation.password.currentWrong' }]);
    }
    if (!passwordIsNotEmail(body.newPassword, user.email)) {
      throw new ValidationException([{ field: 'newPassword', message: 'validation.password.sameAsEmail' }]);
    }
    const passwordHash = await this.passwords.hash(body.newPassword);
    await this.accounts.changePassword(principal, passwordHash, new Date(), client);
  }
}
