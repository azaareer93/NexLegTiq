import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type {
  AdminConfirmEnrollmentRequest,
  AdminEnrollment,
  AdminEnrollRequest,
  AdminLoginRequest,
  AdminProfile,
  AdminSession,
} from '@nexlegtiq/shared-contracts';
import { PinoLogger } from 'nestjs-pino';

import { PlatformAuditService } from './platform-audit.service';
import {
  ADMIN_ACCESS_TTL_SECONDS,
  ADMIN_ACCOUNT_MAX_FAILURES,
  ADMIN_AUDIENCE,
  ADMIN_ENROLMENT_WINDOW_MS,
  ADMIN_JWT,
} from './platform-auth.constants';
import type { AdminAccessClaims } from './platform-auth.constants';
import { PlatformSessions } from './platform-sessions';
import type { IssuedSession } from './platform-sessions';
import { newRecoveryCode, RECOVERY_CODE_COUNT, recoveryCodeHash } from './recovery-codes';
import { newTotpSecret, otpauthUri, verifyTotp } from './totp';
import { FieldCipher } from '../../common/crypto/field-cipher';
import { AppException, ResourceNotFoundException } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import type { PlatformAdmin, Prisma } from '../../generated/prisma/client';
import { JWT_ISSUER } from '../auth/auth.constants';
import type { ClientInfo } from '../auth/client-info';
import { isLocked } from '../auth/lockout';
import { LoginAttemptRepository } from '../auth/login-attempt.repository';
import { PasswordHasher } from '../auth/password-hasher';

export interface AdminSignIn {
  readonly session: AdminSession;
  readonly issued: IssuedSession;
}

const secretContext = (adminId: string) => `platform_admins.mfa_secret:${adminId}`;

/**
 * The platform admin realm (D-145): password + TOTP for every sign-in (recovery codes as the fallback), enrolment within a
 * day of `create-admin`, 8 h / 30 min sessions, the D-053 lockout per address plus an account-wide one, and an audit row
 * for each sign-in. Platform code reads admins through the raw client (D-080).
 */
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: PasswordHasher,
    private readonly attempts: LoginAttemptRepository,
    private readonly cipher: FieldCipher,
    private readonly sessions: PlatformSessions,
    private readonly audit: PlatformAuditService,
    @Inject(ADMIN_JWT) private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PlatformAuthService.name);
  }

  async login(body: AdminLoginRequest, client: ClientInfo): Promise<AdminSignIn> {
    const admin = await this.checkPassword(body.email, body.password, client);
    if (!admin.mfaEnrolledAt || !admin.mfaSecret) throw enrolmentNeeded();
    if (!body.code && !body.recoveryCode) {
      throw new AppException('AUTH-008', 'Admin sign-in needs a verification code');
    }
    const now = new Date();
    const accepted = body.code
      ? await this.acceptCode(admin, body.code, now)
      : await this.acceptRecoveryCode(admin.id, body.recoveryCode ?? '', now);
    if (!accepted) {
      await this.attempts.record(body.email, client.ip, false);
      throw new AppException('AUTH-009', 'Wrong verification code');
    }
    // unscoped: platform admins belong to no office (D-079).
    const issued = await this.prisma
      .unscoped()
      .$transaction((tx) =>
        this.startSession(tx, admin, client, now, body.code ? 'LOGIN' : 'LOGIN_RECOVERY_CODE'),
      );
    return this.signedIn(admin, client, issued);
  }

  /** A not-yet-enrolled admin's secret to scan; asking again replaces the one not confirmed yet. */
  async enroll(body: AdminEnrollRequest, client: ClientInfo): Promise<AdminEnrollment> {
    const admin = await this.enrollable(body.email, body.password, client);
    const secret = newTotpSecret();
    // unscoped: see login().
    const stored = await this.prisma.unscoped().platformAdmin.updateMany({
      where: { id: admin.id, mfaEnrolledAt: null },
      data: { mfaSecret: this.cipher.encrypt(secret, secretContext(admin.id)), mfaLastStep: null },
    });
    // Confirmed meanwhile: this secret was never stored, so it must not be shown.
    if (stored.count !== 1) throw new AppException('RES-003', 'Authenticator already set up');
    return { otpauthUri: otpauthUri(secret, admin.email), secret };
  }

  /**
   * The first code proves the app holds the secret. Enrolment, the recovery codes and the first session commit together,
   * so the codes are never stored without being shown.
   */
  async confirmEnrollment(
    body: AdminConfirmEnrollmentRequest,
    client: ClientInfo,
  ): Promise<AdminSignIn> {
    const admin = await this.enrollable(body.email, body.password, client);
    if (!admin.mfaSecret) throw enrolmentNeeded();
    const now = new Date();
    const step = verifyTotp(
      this.cipher.decrypt(admin.mfaSecret, secretContext(admin.id)),
      body.code,
      now,
      null,
    );
    if (step === null) {
      await this.attempts.record(body.email, client.ip, false);
      throw new AppException('AUTH-009', 'Wrong verification code');
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    // unscoped: see login().
    const issued = await this.prisma.unscoped().$transaction(async (tx) => {
      const done = await tx.platformAdmin.updateMany({
        where: { id: admin.id, mfaEnrolledAt: null, mfaSecret: admin.mfaSecret },
        data: { mfaEnrolledAt: now, mfaLastStep: step },
      });
      if (done.count !== 1) return null; // a second confirmation, or a new secret asked for meanwhile
      await tx.platformRecoveryCode.deleteMany({ where: { adminId: admin.id } });
      await tx.platformRecoveryCode.createMany({
        data: codes.map((code) => ({ adminId: admin.id, codeHash: recoveryCodeHash(code) })),
      });
      await this.audit.log(
        {
          adminId: admin.id,
          action: 'MFA_ENROLLED',
          entityType: 'PlatformAdmin',
          entityId: admin.id,
        },
        client,
        tx,
      );
      return this.startSession(tx, admin, client, now, 'LOGIN');
    });
    if (!issued) throw new AppException('RES-003', 'Authenticator setup changed meanwhile');
    const signedIn = await this.signedIn(admin, client, issued);
    return { ...signedIn, session: { ...signedIn.session, recoveryCodes: codes } };
  }

  async refresh(token: string | undefined, client: ClientInfo): Promise<AdminSignIn> {
    if (!token) throw new AppException('AUTH-005', 'No admin session');
    const now = new Date();
    const issued = await this.sessions.rotate(token, now, client);
    const admin = await this.findActive(issued.adminId);
    if (!admin) {
      await this.sessions.end(issued.refreshToken, now);
      throw new AppException('AUTH-006', 'Admin account not active');
    }
    return { issued, session: await this.sessionFor(admin, issued.familyId) };
  }

  /** Idempotent: an unknown or already ended token ends nothing and writes nothing. */
  async logout(token: string | undefined, client: ClientInfo): Promise<void> {
    if (!token) return;
    const adminId = await this.sessions.end(token, new Date());
    if (adminId) {
      await this.audit.log(
        { adminId, action: 'LOGOUT', entityType: 'PlatformAdmin', entityId: adminId },
        client,
      );
    }
  }

  async profile(adminId: string): Promise<AdminProfile> {
    const admin = await this.findActive(adminId);
    if (!admin) throw new ResourceNotFoundException();
    return { id: admin.id, fullName: admin.fullName, email: admin.email };
  }

  /**
   * D-053 lockout per address, plus the account-wide one (10 failures from any address in 15 min: a botnet cannot
   * spread guesses of the password or of the 6-digit code), then the password (dummy hash for unknown emails, D-082).
   */
  private async checkPassword(
    email: string,
    password: string,
    client: ClientInfo,
  ): Promise<PlatformAdmin> {
    const now = new Date();
    const [failures, accountFailures] = await Promise.all([
      this.attempts.recentFailures(email, client.ip, now),
      this.attempts.accountFailures(email, now),
    ]);
    if (isLocked(failures, now) || accountFailures >= ADMIN_ACCOUNT_MAX_FAILURES) {
      throw new AppException('AUTH-007', 'Too many failed attempts');
    }
    // unscoped: see login().
    const admin = await this.prisma.unscoped().platformAdmin.findUnique({ where: { email } });
    const valid = await this.hasher.verify(admin?.passwordHash, password);
    if (!admin || !valid || !admin.isActive) {
      await this.attempts.record(email, client.ip, false);
      throw admin && valid
        ? new AppException('AUTH-006', 'Admin account not active')
        : new AppException('AUTH-001', 'Invalid admin credentials');
    }
    return admin;
  }

  /** Enrolment needs the password, an admin not enrolled yet, and to happen within a day of `create-admin`. */
  private async enrollable(email: string, password: string, client: ClientInfo) {
    const admin = await this.checkPassword(email, password, client);
    if (admin.mfaEnrolledAt) throw new AppException('RES-003', 'Authenticator already set up');
    if (Date.now() - admin.createdAt.getTime() > ADMIN_ENROLMENT_WINDOW_MS) {
      throw new AppException('RES-004', 'Enrolment window over: re-create the admin');
    }
    return admin;
  }

  /** The app's code, newer than the last one accepted (claimed conditionally, so it cannot be used twice at once). */
  private async acceptCode(admin: PlatformAdmin, code: string, now: Date): Promise<boolean> {
    const secret = this.cipher.decrypt(admin.mfaSecret ?? '', secretContext(admin.id));
    const step = verifyTotp(secret, code, now, admin.mfaLastStep);
    if (step === null) return false;
    // unscoped: see login().
    const claimed = await this.prisma.unscoped().platformAdmin.updateMany({
      where: { id: admin.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
      data: { mfaLastStep: step },
    });
    return claimed.count === 1;
  }

  private async acceptRecoveryCode(adminId: string, code: string, now: Date): Promise<boolean> {
    // unscoped: see login().
    const used = await this.prisma.unscoped().platformRecoveryCode.updateMany({
      where: { adminId, codeHash: recoveryCodeHash(code), usedAt: null },
      data: { usedAt: now },
    });
    return used.count === 1;
  }

  /** The session, the last sign-in time and the audit row, in the caller's transaction. */
  private async startSession(
    tx: Prisma.TransactionClient,
    admin: PlatformAdmin,
    client: ClientInfo,
    now: Date,
    action: string,
  ): Promise<IssuedSession> {
    const session = await this.sessions.start(tx, admin.id, now);
    await tx.platformAdmin.update({ where: { id: admin.id }, data: { lastLoginAt: now } });
    await this.audit.log(
      { adminId: admin.id, action, entityType: 'PlatformAdmin', entityId: admin.id },
      client,
      tx,
    );
    return session;
  }

  /** After the commit: the success resets the address lock (best effort — the session already exists) and the token. */
  private async signedIn(
    admin: PlatformAdmin,
    client: ClientInfo,
    issued: IssuedSession,
  ): Promise<AdminSignIn> {
    await this.attempts.record(admin.email, client.ip, true).catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Admin sign-in success not recorded');
    });
    return { issued, session: await this.sessionFor(admin, issued.familyId) };
  }

  private async sessionFor(
    admin: Pick<PlatformAdmin, 'id' | 'fullName' | 'email'>,
    familyId: string,
  ): Promise<AdminSession> {
    const claims: AdminAccessClaims = { sub: admin.id, sid: familyId };
    const accessToken = await this.jwt.signAsync(claims, {
      secret: this.secret(),
      audience: ADMIN_AUDIENCE,
      issuer: JWT_ISSUER,
      expiresIn: ADMIN_ACCESS_TTL_SECONDS,
    });
    return {
      accessToken,
      expiresIn: ADMIN_ACCESS_TTL_SECONDS,
      admin: { id: admin.id, fullName: admin.fullName, email: admin.email },
    };
  }

  private findActive(adminId: string): Promise<PlatformAdmin | null> {
    // unscoped: see login().
    return this.prisma
      .unscoped()
      .platformAdmin.findFirst({ where: { id: adminId, isActive: true } });
  }

  private secret(): string {
    const admin = this.config.admin;
    if (!admin) throw new ResourceNotFoundException();
    return admin.jwtSecret;
  }
}

/** Password right, authenticator not set up yet: the app goes to enrolment (D-145). */
function enrolmentNeeded(): AppException {
  return new AppException('AUTH-008', 'Admin authenticator not set up', [
    { field: 'code', message: 'validation.mfaEnrollment' },
  ]);
}
