import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '../generated/prisma/client';
import type { TenantModel } from './tenant-models';

/** One office seeded for isolation tests, with the rows other tenant rows need to reference. */
export interface SeededOffice {
  readonly officeId: string;
  readonly userId: string;
  readonly planId: string;
}

/**
 * One entry per tenant model (asserted against TENANT_MODELS). `create` makes a row in the given office with the raw
 * client; `update` is a harmless change used to prove another office's row cannot be touched.
 * `http` lists the resource's endpoints once it has any; tenant-isolation.int.spec.ts then also checks
 * list/get/update/delete → 404 RES-001 for the other office, calling as the seeded user with
 * `bearerFor(app.get(JwtService), { ...office, role: 'OFFICE_MANAGER' })` from modules/auth/auth.test-helper.ts.
 */
export interface TenantResource {
  readonly model: TenantModel;
  create(db: PrismaClient, office: SeededOffice): Promise<{ id: string }>;
  readonly update: Record<string, unknown>;
  readonly http?: { readonly list: string; readonly item: (id: string) => string };
}

const soon = (): Date => new Date(Date.now() + 3_600_000);

export const TENANT_ISOLATION_MATRIX: readonly TenantResource[] = [
  {
    model: 'OfficeSettings',
    create: (db, { officeId }) => db.officeSettings.create({ data: { officeId } }),
    update: { sessionIdleMinutes: 45 },
  },
  {
    model: 'User',
    create: (db, { officeId }) =>
      db.user.create({
        data: { officeId, fullName: 'Isolation', email: `iso-${randomUUID()}@example.test`, passwordHash: '!', role: 'LAWYER' },
      }),
    update: { fullName: 'Renamed' },
  },
  {
    model: 'OfficeInvitation',
    create: (db, { officeId, userId }) =>
      db.officeInvitation.create({
        data: {
          officeId,
          invitedById: userId,
          email: `invite-${randomUUID()}@example.test`,
          role: 'LAWYER',
          tokenHash: randomUUID(),
          expiresAt: soon(),
        },
      }),
    update: { message: 'changed' },
  },
  {
    model: 'RefreshToken',
    create: (db, { officeId, userId }) =>
      db.refreshToken.create({ data: { officeId, userId, familyId: randomUUID(), tokenHash: randomUUID(), expiresAt: soon() } }),
    update: { userAgent: 'changed' },
  },
  {
    model: 'PasswordResetToken',
    create: (db, { officeId, userId }) =>
      db.passwordResetToken.create({ data: { officeId, userId, tokenHash: randomUUID(), expiresAt: soon() } }),
    update: { usedAt: new Date() },
  },
  {
    model: 'LegalAcceptance',
    create: (db, { officeId, userId }) =>
      db.legalAcceptance.create({ data: { officeId, userId, documentType: 'TOS', version: randomUUID() } }),
    update: { ipAddress: '127.0.0.1' },
  },
  {
    model: 'Subscription',
    create: (db, { officeId, planId }) =>
      db.subscription.create({ data: { officeId, planId, status: 'CANCELLED', currentPeriodStart: new Date() } }),
    update: { notes: 'changed' },
  },
  {
    model: 'AuditLog',
    create: (db, { officeId, userId }) =>
      db.auditLog.create({ data: { officeId, userId, entityType: 'IsolationTest', action: 'VIEW' } }),
    update: { userAgent: 'changed' },
  },
  {
    model: 'Notification',
    create: (db, { officeId, userId }) =>
      db.notification.create({ data: { officeId, userId, type: 'TEST', titleKey: 'test.title' } }),
    update: { readAt: new Date() },
  },
];
