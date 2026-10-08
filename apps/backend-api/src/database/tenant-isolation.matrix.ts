import { randomUUID } from 'node:crypto';

import type { TenantModel } from './tenant-models';
import type { PrismaClient } from '../generated/prisma/client';

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

const clientIn = (db: PrismaClient, { officeId }: SeededOffice) =>
  db.client.create({
    data: { officeId, clientType: 'INDIVIDUAL', displayName: 'Isolation client' },
  });

const fileIn = (db: PrismaClient, { officeId, userId }: SeededOffice) =>
  db.legalFile.create({
    data: {
      officeId,
      fileNumber: `ISO-${randomUUID()}`,
      title: 'Isolation file',
      fileType: 'LITIGATION',
      responsibleLawyerId: userId,
      jurisdiction: 'PALESTINE',
      currency: 'ILS',
    },
  });

const partyIn = (db: PrismaClient, { officeId }: SeededOffice) =>
  db.party.create({ data: { officeId, isIndividual: true, fullName: 'Isolation party' } });

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
        data: {
          officeId,
          fullName: 'Isolation',
          email: `iso-${randomUUID()}@example.test`,
          passwordHash: '!',
          role: 'LAWYER',
        },
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
      db.refreshToken.create({
        data: {
          officeId,
          userId,
          familyId: randomUUID(),
          tokenHash: randomUUID(),
          expiresAt: soon(),
        },
      }),
    update: { userAgent: 'changed' },
  },
  {
    model: 'PasswordResetToken',
    create: (db, { officeId, userId }) =>
      db.passwordResetToken.create({
        data: { officeId, userId, tokenHash: randomUUID(), expiresAt: soon() },
      }),
    update: { usedAt: new Date() },
  },
  {
    model: 'EmailVerificationToken',
    create: (db, { officeId, userId }) =>
      db.emailVerificationToken.create({
        data: { officeId, userId, tokenHash: randomUUID(), expiresAt: soon() },
      }),
    update: { usedAt: new Date() },
  },
  {
    model: 'LegalAcceptance',
    create: (db, { officeId, userId }) =>
      db.legalAcceptance.create({
        data: { officeId, userId, documentType: 'TOS', version: randomUUID() },
      }),
    update: { ipAddress: '127.0.0.1' },
  },
  {
    model: 'Subscription',
    create: (db, { officeId, planId }) =>
      db.subscription.create({
        data: { officeId, planId, status: 'CANCELLED', currentPeriodStart: new Date() },
      }),
    update: { notes: 'changed' },
  },
  {
    model: 'AuditLog',
    create: (db, { officeId, userId }) =>
      db.auditLog.create({
        data: { officeId, userId, entityType: 'IsolationTest', action: 'VIEW' },
      }),
    update: { userAgent: 'changed' },
  },
  {
    model: 'Notification',
    create: (db, { officeId, userId }) =>
      db.notification.create({ data: { officeId, userId, type: 'TEST', titleKey: 'test.title' } }),
    update: { readAt: new Date() },
  },
  { model: 'Client', create: clientIn, update: { phone: '0599000000' } },
  { model: 'LegalFile', create: fileIn, update: { title: 'Renamed' } },
  {
    model: 'FileClient',
    create: async (db, office) =>
      db.fileClient.create({
        data: {
          officeId: office.officeId,
          fileId: (await fileIn(db, office)).id,
          clientId: (await clientIn(db, office)).id,
        },
      }),
    update: { isPrimary: true },
  },
  {
    model: 'FileTeamMember',
    create: async (db, office) =>
      db.fileTeamMember.create({
        data: {
          officeId: office.officeId,
          fileId: (await fileIn(db, office)).id,
          userId: office.userId,
        },
      }),
    update: { role: 'PARALEGAL' },
  },
  {
    model: 'FileNumberSequence',
    create: (db, { officeId }) =>
      db.fileNumberSequence.create({
        data: { officeId, year: 2026, typeCode: randomUUID(), lastValue: 1 },
      }),
    update: { lastValue: 2 },
  },
  { model: 'Party', create: partyIn, update: { phone: '0599000000' } },
  {
    model: 'FileParty',
    create: async (db, office) =>
      db.fileParty.create({
        data: {
          officeId: office.officeId,
          fileId: (await fileIn(db, office)).id,
          partyId: (await partyIn(db, office)).id,
          partyType: 'DEFENDANT',
        },
      }),
    update: { roleLabel: 'Landlord' },
  },
  {
    model: 'ConflictOfInterest',
    create: async (db, office) =>
      db.conflictOfInterest.create({
        data: {
          officeId: office.officeId,
          fileIdA: (await fileIn(db, office)).id,
          fileIdB: (await fileIn(db, office)).id,
          partyId: (await partyIn(db, office)).id,
          reason: 'ADVERSE_PARTY',
        },
      }),
    update: { resolutionNotes: 'changed' },
  },
  {
    model: 'CaseTimelineEvent',
    create: async (db, office) =>
      db.caseTimelineEvent.create({
        data: {
          officeId: office.officeId,
          fileId: (await fileIn(db, office)).id,
          eventType: 'FILE_OPENED',
        },
      }),
    update: { sourceType: 'changed' },
  },
  {
    model: 'FileNote',
    create: async (db, office) =>
      db.fileNote.create({
        data: {
          officeId: office.officeId,
          fileId: (await fileIn(db, office)).id,
          authorId: office.userId,
          body: 'Isolation note',
        },
      }),
    update: { pinned: true },
  },
  {
    model: 'TaskTemplate',
    create: (db, { officeId }) =>
      db.taskTemplate.create({
        data: { officeId, name: 'Isolation', defaultTitle: 'File the claim' },
      }),
    update: { name: 'Renamed' },
  },
];
