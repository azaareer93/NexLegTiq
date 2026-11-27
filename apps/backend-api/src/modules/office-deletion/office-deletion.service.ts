import { Injectable } from '@nestjs/common';
import { OFFICE_DELETION_GRACE_DAYS } from '@nexlegtiq/shared-contracts';
import type {
  OfficeDeletionStatus,
  RequestOfficeDeletionRequest,
} from '@nexlegtiq/shared-contracts';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { OfficeDeletionMailer } from './office-deletion.mailer';
import type { DeletionEvent } from './office-deletion.mailer';
import { auditRow } from '../../common/audit/audit.service';
import type { ClientInfo } from '../../common/context/client-info';
import type { RequestContext } from '../../common/context/request-context';
import { FieldCipher } from '../../common/crypto/field-cipher';
import {
  ResourceConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import { PasswordHasher } from '../auth/password-hasher';
import { PlatformAuditService } from '../platform-auth/platform-audit.service';
import { verifyTotp } from '../platform-auth/totp';
import { EntitlementsService } from '../subscriptions/entitlements.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS = { deletionRequestedAt: true, deletionScheduledFor: true } as const;

/** The office's own deletion state, or the admin detail's (D-251); null when never asked and never purged. */
export function deletionOf(office: {
  deletionRequestedAt: Date | null;
  deletionScheduledFor: Date | null;
  purgedAt: Date | null;
}): { requestedAt: string | null; scheduledFor: string | null; purgedAt: string | null } | null {
  if (!office.deletionScheduledFor && !office.purgedAt) return null;
  return {
    requestedAt: office.deletionRequestedAt?.toISOString() ?? null,
    scheduledFor: office.deletionScheduledFor?.toISOString() ?? null,
    purgedAt: office.purgedAt?.toISOString() ?? null,
  };
}

/**
 * Office deletion (MVP-152, D-251): the office manager asks (password + MFA code), any office manager cancels during the
 * 30-day read-only grace; platform staff cancel at any time or bring the date forward on the office's written request.
 * The purge itself is `OfficePurge` (worker).
 */
@Injectable()
export class OfficeDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly cls: ClsService<RequestContext>,
    private readonly passwords: PasswordHasher,
    private readonly cipher: FieldCipher,
    private readonly entitlements: EntitlementsService,
    private readonly platformAudit: PlatformAuditService,
    private readonly mailer: OfficeDeletionMailer,
  ) {}

  async status(): Promise<OfficeDeletionStatus> {
    const office = await this.prisma.db.office.findFirstOrThrow({ select: STATUS });
    return present(office);
  }

  async request(
    body: RequestOfficeDeletionRequest,
    client: ClientInfo,
  ): Promise<OfficeDeletionStatus> {
    await this.reauthenticate(body);
    const now = new Date();
    const scheduledFor = new Date(now.getTime() + OFFICE_DELETION_GRACE_DAYS * DAY_MS);
    await this.uow.run(async (tx) => {
      // Conditional update: a second request (or a race) changes and audits nothing.
      const { count } = await tx.office.updateMany({
        where: { id: this.officeId(), deletionScheduledFor: null, purgedAt: null },
        data: { deletionRequestedAt: now, deletionScheduledFor: scheduledFor },
      });
      if (count === 0) throw new ResourceConflictException('RES-003', 'Deletion already scheduled');
      await tx.auditLog.create({
        data: this.auditRow(client, { deletion: 'REQUESTED', scheduledFor }),
      });
    });
    await this.changed(this.officeId(), 'requested', scheduledFor);
    return this.status();
  }

  async cancel(client: ClientInfo): Promise<OfficeDeletionStatus> {
    await this.uow.run(async (tx) => {
      const { count } = await tx.office.updateMany({
        where: { id: this.officeId(), deletionScheduledFor: { not: null }, purgedAt: null },
        data: { deletionRequestedAt: null, deletionScheduledFor: null },
      });
      if (count === 0) throw new ResourceConflictException('RES-003', 'No deletion is scheduled');
      await tx.auditLog.create({ data: this.auditRow(client, { deletion: 'CANCELLED' }) });
    });
    await this.changed(this.officeId(), 'cancelled', null);
    return this.status();
  }

  /** Platform staff, at any time before the purge; the reason goes to the platform audit log. */
  async adminCancel(
    officeId: string,
    reason: string,
    adminId: string,
    client: ClientInfo,
  ): Promise<void> {
    const raw = this.prisma.unscoped(); // unscoped: platform admin code changes any office (D-080).
    await raw.$transaction(async (tx) => {
      const before = await this.scheduledOf(tx, officeId);
      await tx.office.update({
        where: { id: officeId },
        data: { deletionRequestedAt: null, deletionScheduledFor: null },
      });
      await this.platformAudit.log(
        {
          adminId,
          action: 'OFFICE_DELETION_CANCELLED',
          entityType: 'Office',
          entityId: officeId,
          targetOfficeId: officeId,
          oldValues: { scheduledFor: before.toISOString() },
          newValues: { reason },
        },
        client,
        tx,
      );
    });
    await this.changed(officeId, 'cancelled', null);
  }

  /** Only earlier, never in the past: the office asked in writing (its reference is in the reason). */
  async adminReschedule(
    officeId: string,
    scheduledFor: Date,
    reason: string,
    adminId: string,
    client: ClientInfo,
  ): Promise<void> {
    const raw = this.prisma.unscoped(); // unscoped: platform admin code changes any office (D-080).
    await raw.$transaction(async (tx) => {
      const before = await this.scheduledOf(tx, officeId);
      if (scheduledFor.getTime() < Date.now() || scheduledFor >= before) {
        throw new ValidationException([
          { field: 'scheduledFor', message: 'validation.deletionDate' },
        ]);
      }
      await tx.office.update({
        where: { id: officeId },
        data: { deletionScheduledFor: scheduledFor },
      });
      await this.platformAudit.log(
        {
          adminId,
          action: 'OFFICE_DELETION_RESCHEDULED',
          entityType: 'Office',
          entityId: officeId,
          targetOfficeId: officeId,
          oldValues: { scheduledFor: before.toISOString() },
          newValues: { scheduledFor: scheduledFor.toISOString(), reason },
        },
        client,
        tx,
      );
    });
    await this.changed(officeId, 'rescheduled', scheduledFor);
  }

  /** The office's scheduled date, locked; 404 for an unknown office, 409 when none is scheduled (or it is purged). */
  private async scheduledOf(tx: Prisma.TransactionClient, officeId: string): Promise<Date> {
    const rows = await tx.$queryRaw<{ scheduled: Date | null; purged: Date | null }[]>`
      SELECT deletion_scheduled_for AS scheduled, purged_at AS purged
      FROM offices WHERE id = ${officeId}::uuid FOR UPDATE`;
    const [row] = rows;
    if (!row) throw new ResourceNotFoundException();
    if (!row.scheduled || row.purged) {
      throw new ResourceConflictException('RES-003', 'No deletion is scheduled');
    }
    return row.scheduled;
  }

  /** The password again, and the TOTP code when the user has MFA on; any failure is a field error, never a 401. */
  private async reauthenticate(body: RequestOfficeDeletionRequest): Promise<void> {
    const user = await this.prisma.db.user.findFirstOrThrow({
      where: { id: this.userId() },
      select: { id: true, passwordHash: true, mfaEnabled: true, mfaSecret: true },
    });
    if (!(await this.passwords.verify(user.passwordHash, body.password))) {
      throw new ValidationException([
        { field: 'password', message: 'validation.password.currentWrong' },
      ]);
    }
    if (!user.mfaEnabled) return;
    if (!body.mfaCode) {
      throw new ValidationException([{ field: 'mfaCode', message: 'validation.required' }]);
    }
    // shortcut: office MFA has no enrolment yet; the secret context follows the platform's (D-145) for when it comes.
    const secret = this.cipher.decrypt(user.mfaSecret ?? '', `users.mfa_secret:${user.id}`);
    if (verifyTotp(secret, body.mfaCode, new Date(), null) === null) {
      throw new ValidationException([{ field: 'mfaCode', message: 'validation.totpWrong' }]);
    }
  }

  /** After the commit: read-only applies at once in this process, and the office managers hear of it. */
  private async changed(
    officeId: string,
    event: DeletionEvent,
    scheduledFor: Date | null,
  ): Promise<void> {
    this.entitlements.invalidate(officeId as OfficeId);
    await this.mailer.notify(officeId, event, scheduledFor);
  }

  private auditRow(client: ClientInfo, newValues: object) {
    return auditRow(
      {
        officeId: this.officeId(),
        userId: this.userId(),
        entityType: 'Office',
        entityId: this.officeId(),
        action: 'SECURITY',
        newValues,
      },
      client,
    );
  }

  private userId(): string {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No user in the request context');
    return userId;
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }
}

function present(office: {
  deletionRequestedAt: Date | null;
  deletionScheduledFor: Date | null;
}): OfficeDeletionStatus {
  return {
    requestedAt: office.deletionRequestedAt?.toISOString() ?? null,
    scheduledFor: office.deletionScheduledFor?.toISOString() ?? null,
  };
}
