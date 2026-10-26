import { randomBytes } from 'node:crypto';

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

import { PlatformAuditService } from './platform-audit.service';
import {
  ADMIN_ACCESS_TTL_SECONDS,
  ADMIN_AUDIENCE,
  ADMIN_JWT,
  RECOVERY_CODE_COUNT,
} from './platform-auth.constants';
import type { AdminAccessClaims } from './platform-auth.constants';
import { PlatformSessions } from './platform-sessions';
import type { IssuedSession } from './platform-sessions';
import { base32Encode, newTotpSecret, otpauthUri, verifyTotp } from './totp';
import { hashOpaqueToken } from '../../common/auth/opaque-token';
import { FieldCipher } from '../../common/crypto/field-cipher';
import { AppException, ResourceNotFoundException } from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import type { PlatformAdmin } from '../../generated/prisma/client';
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
/** Recovery codes are compared without case or dash. */
const normaliseRecoveryCode = (code: string): string => code.replace('-', '').toUpperCase();
const newRecoveryCode = (): string => {
  const text = base32Encode(randomBytes(7)).slice(0, 10);
  return `${text.slice(0, 5)}-${text.slice(5)}`;
};

/**
 * The platform admin realm (D-145): password + TOTP for every sign-in (recovery codes as the fallback), enrolment on first
 * sign-in, 8 h / 30 min sessions, the D-053 lockout and an audit row for each sign-in. No public signup: admins are made
 * with the `create-admin` command. Platform code reads admins through the raw client (D-080).
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
  ) {}

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
    return this.signIn(admin, client, now, body.code ? 'LOGIN' : 'LOGIN_RECOVERY_CODE');
  }

  /** A not-yet-enrolled admin's secret to scan; asking again replaces the one not confirmed yet. */
  async enroll(body: AdminEnrollRequest, client: ClientInfo): Promise<AdminEnrollment> {
    const admin = await this.checkPassword(body.email, body.password, client);
    if (admin.mfaEnrolledAt) throw new AppException('RES-003', 'Authenticator already set up');
    const secret = newTotpSecret();
    // unscoped: platform admins belong to no office.
    await this.prisma.unscoped().platformAdmin.updateMany({
      where: { id: admin.id, mfaEnrolledAt: null },
      data: { mfaSecret: this.cipher.encrypt(secret, secretContext(admin.id)), mfaLastStep: null },
    });
    return { otpauthUri: otpauthUri(secret, admin.email), secret };
  }

  /** The first code proves the app holds the secret: enrolment ends, recovery codes are made, the admin is signed in. */
  async confirmEnrollment(
    body: AdminConfirmEnrollmentRequest,
    client: ClientInfo,
  ): Promise<AdminSignIn> {
    const admin = await this.checkPassword(body.email, body.password, client);
    if (admin.mfaEnrolledAt) throw new AppException('RES-003', 'Authenticator already set up');
    if (!admin.mfaSecret) throw enrolmentNeeded();
    const now = new Date();
    const secret = this.cipher.decrypt(admin.mfaSecret, secretContext(admin.id));
    const step = verifyTotp(secret, body.code, now, null);
    if (step === null) {
      await this.attempts.record(body.email, client.ip, false);
      throw new AppException('AUTH-009', 'Wrong verification code');
    }
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    // unscoped: see enroll().
    const enrolled = await this.prisma.unscoped().$transaction(async (tx) => {
      const done = await tx.platformAdmin.updateMany({
        where: { id: admin.id, mfaEnrolledAt: null, mfaSecret: admin.mfaSecret },
        data: { mfaEnrolledAt: now, mfaLastStep: step },
      });
      if (done.count !== 1) return false;
      await tx.platformRecoveryCode.deleteMany({ where: { adminId: admin.id } });
      await tx.platformRecoveryCode.createMany({
        data: codes.map((code) => ({
          adminId: admin.id,
          codeHash: hashOpaqueToken(normaliseRecoveryCode(code)),
        })),
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
      return true;
    });
    // A second confirmation racing this one, or a new secret asked for meanwhile.
    if (!enrolled) throw new AppException('RES-003', 'Authenticator setup changed meanwhile');
    const signedIn = await this.signIn(admin, client, now, 'LOGIN');
    return { ...signedIn, session: { ...signedIn.session, recoveryCodes: codes } };
  }

  async refresh(token: string | undefined): Promise<AdminSignIn> {
    if (!token) throw new AppException('AUTH-005', 'No admin session');
    const now = new Date();
    const issued = await this.sessions.rotate(token, now);
    const admin = await this.findActive(issued.adminId);
    if (!admin) {
      await this.sessions.end(issued.refreshToken, now);
      throw new AppException('AUTH-006', 'Admin account not active');
    }
    return { issued, session: await this.sessionFor(admin, issued.familyId) };
  }

  /** Idempotent: an unknown token ends nothing and writes nothing. */
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

  /** D-053 lockout, then the password (unknown emails pay for a dummy hash, D-082); any refusal is recorded. */
  private async checkPassword(
    email: string,
    password: string,
    client: ClientInfo,
  ): Promise<PlatformAdmin> {
    const now = new Date();
    if (isLocked(await this.attempts.recentFailures(email, client.ip, now), now)) {
      throw new AppException('AUTH-007', 'Too many failed attempts');
    }
    // unscoped: platform admins belong to no office (D-079).
    const admin = await this.prisma.unscoped().platformAdmin.findUnique({ where: { email } });
    const valid = await this.hasher.verify(admin?.passwordHash, password);
    if (!admin || !valid) {
      await this.attempts.record(email, client.ip, false);
      throw new AppException('AUTH-001', 'Invalid admin credentials');
    }
    if (!admin.isActive) {
      await this.attempts.record(email, client.ip, false);
      throw new AppException('AUTH-006', 'Admin account not active');
    }
    return admin;
  }

  /** The app's code, newer than the last one accepted (claimed conditionally, so it cannot be used twice at once). */
  private async acceptCode(admin: PlatformAdmin, code: string, now: Date): Promise<boolean> {
    const secret = this.cipher.decrypt(admin.mfaSecret ?? '', secretContext(admin.id));
    const step = verifyTotp(secret, code, now, admin.mfaLastStep);
    if (step === null) return false;
    // unscoped: see checkPassword().
    const claimed = await this.prisma.unscoped().platformAdmin.updateMany({
      where: { id: admin.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] },
      data: { mfaLastStep: step },
    });
    return claimed.count === 1;
  }

  private async acceptRecoveryCode(adminId: string, code: string, now: Date): Promise<boolean> {
    // unscoped: see checkPassword().
    const used = await this.prisma.unscoped().platformRecoveryCode.updateMany({
      where: { adminId, codeHash: hashOpaqueToken(normaliseRecoveryCode(code)), usedAt: null },
      data: { usedAt: now },
    });
    return used.count === 1;
  }

  private async signIn(
    admin: PlatformAdmin,
    client: ClientInfo,
    now: Date,
    action: string,
  ): Promise<AdminSignIn> {
    // unscoped: see checkPassword().
    const issued = await this.prisma.unscoped().$transaction(async (tx) => {
      const session = await this.sessions.start(tx, admin.id, now);
      await tx.platformAdmin.update({ where: { id: admin.id }, data: { lastLoginAt: now } });
      await this.audit.log(
        { adminId: admin.id, action, entityType: 'PlatformAdmin', entityId: admin.id },
        client,
        tx,
      );
      return session;
    });
    await this.attempts.record(admin.email, client.ip, true);
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
    // unscoped: see checkPassword().
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
