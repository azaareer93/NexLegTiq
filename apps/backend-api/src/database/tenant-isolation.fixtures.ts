import { randomUUID } from 'node:crypto';

import type { SeededOffice, TenantResource } from './tenant-isolation.matrix';
import type { PrismaClient } from '../generated/prisma/client';

/** Rows the isolation matrix creates in one office (raw client), and the parents other rows reference. */

export const soon = (): Date => new Date(Date.now() + 3_600_000);

export const clientIn = (db: PrismaClient, { officeId }: SeededOffice) =>
  db.client.create({
    data: { officeId, clientType: 'INDIVIDUAL', displayName: 'Isolation client' },
  });

export const fileIn = (db: PrismaClient, { officeId, userId }: SeededOffice) =>
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

export const notificationIn = (db: PrismaClient, { officeId, userId }: SeededOffice) =>
  db.notification.create({
    data: { officeId, userId, type: 'TASK_ASSIGNED', titleKey: 'test.title' },
  });

export const partyIn = (db: PrismaClient, { officeId }: SeededOffice) =>
  db.party.create({ data: { officeId, isIndividual: true, fullName: 'Isolation party' } });

export const sessionIn = async (db: PrismaClient, office: SeededOffice) =>
  db.session.create({
    data: {
      officeId: office.officeId,
      fileId: (await fileIn(db, office)).id,
      startsAt: soon(),
      attendingLawyerId: office.userId,
      createdById: office.userId,
      reminderDays: [],
    },
  });

export const reminderIn = async (db: PrismaClient, office: SeededOffice) =>
  db.sessionReminder.create({
    data: {
      officeId: office.officeId,
      sessionId: (await sessionIn(db, office)).id,
      recipientId: office.userId,
      daysBefore: 1,
      scheduledFor: new Date(),
    },
  });

export const folderIn = async (db: PrismaClient, office: SeededOffice) =>
  db.documentFolder.create({
    data: {
      officeId: office.officeId,
      fileId: (await fileIn(db, office)).id,
      name: 'Isolation folder',
    },
  });

/** A document with its first version; the storage key starts with the office (D-035, CHECK). */
export const documentIn = async (db: PrismaClient, office: SeededOffice) => {
  const { officeId, userId } = office;
  const fileId = (await fileIn(db, office)).id;
  const stored = {
    originalFilename: 'isolation.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024n,
    checksumSha256: 'a'.repeat(64),
    storageKey: `${officeId}/${fileId}/${randomUUID()}.pdf`,
  };
  const document = await db.document.create({
    data: { officeId, fileId, name: 'Isolation document', ...stored, uploadedById: userId },
  });
  // Tenant rows are written with scalar foreign keys, never nested (D-080).
  await db.documentVersion.create({
    data: { officeId, documentId: document.id, versionNumber: 1, createdById: userId, ...stored },
  });
  return document;
};

export const versionIn = async (db: PrismaClient, office: SeededOffice) =>
  db.documentVersion.findFirstOrThrow({
    where: { documentId: (await documentIn(db, office)).id },
  });

export const documentTextIn = async (db: PrismaClient, office: SeededOffice) =>
  db.documentText.create({
    data: {
      officeId: office.officeId,
      documentId: (await documentIn(db, office)).id,
      versionNumber: 1,
      text: 'Isolation text',
    },
  });

export const aiJobIn = (db: PrismaClient, { officeId, userId }: SeededOffice) =>
  db.aiJob.create({ data: { officeId, createdById: userId, type: 'isolation-test' } });

export const aiSummaryIn = async (db: PrismaClient, office: SeededOffice) =>
  db.aiSummary.create({
    data: {
      officeId: office.officeId,
      sourceType: 'DOCUMENT',
      sourceId: (await documentIn(db, office)).id,
      fileId: (await fileIn(db, office)).id,
      versionNumber: 1,
      language: 'EN',
      summary: 'Isolation test summary.',
      provider: 'fake',
      model: 'fake-1',
      promptVersion: 'document-summary.v1',
      createdById: office.userId,
    },
  });

export const aiFeedbackIn = async (db: PrismaClient, office: SeededOffice) =>
  db.aiFeedback.create({
    data: {
      officeId: office.officeId,
      summaryId: (await aiSummaryIn(db, office)).id,
      userId: office.userId,
      reason: 'OTHER',
    },
  });

export const aiUsageIn = (db: PrismaClient, { officeId, userId }: SeededOffice) =>
  db.aiUsage.create({
    data: {
      officeId,
      userId,
      feature: 'isolation-test',
      provider: 'fake',
      model: 'fake-1',
      inputTokens: 1,
      outputTokens: 1,
      costUsd: '0',
      durationMs: 1,
    },
  });

export const timeEntryIn = async (db: PrismaClient, office: SeededOffice) =>
  db.timeEntry.create({
    data: {
      officeId: office.officeId,
      fileId: (await fileIn(db, office)).id,
      userId: office.userId,
      workDate: new Date('2026-11-09T00:00:00Z'),
      durationHours: '1.50',
      description: 'Isolation work',
      currency: 'ILS',
    },
  });

export const invoiceIn = async (db: PrismaClient, office: SeededOffice) =>
  db.invoice.create({
    data: {
      officeId: office.officeId,
      clientId: (await clientIn(db, office)).id,
      currency: 'ILS',
      subtotal: '100.000',
      taxRatePercent: '0',
      taxAmount: '0.000',
      total: '100.000',
      createdById: office.userId,
    },
  });

export const invoiceLineIn = async (db: PrismaClient, office: SeededOffice) =>
  db.invoiceLineItem.create({
    data: {
      officeId: office.officeId,
      invoiceId: (await invoiceIn(db, office)).id,
      description: 'Isolation line',
      quantity: '1.00',
      unitPrice: '100.000',
      amount: '100.000',
      position: 0,
    },
  });

export const timerIn = async (db: PrismaClient, office: SeededOffice) =>
  db.timeTimer.create({
    data: {
      officeId: office.officeId,
      fileId: (await fileIn(db, office)).id,
      userId: office.userId,
    },
  });

export const portalAccessIn = async (db: PrismaClient, office: SeededOffice) => {
  const clientUser = await db.clientUser.create({
    data: {
      email: `iso-portal-${randomUUID()}@example.test`,
      fullName: 'Isolation',
      passwordHash: '!',
    },
  });
  return db.clientPortalAccess.create({
    data: {
      officeId: office.officeId,
      clientUserId: clientUser.id,
      clientId: (await clientIn(db, office)).id,
      grantedById: office.userId,
    },
  });
};

export const clientInvitationIn = async (db: PrismaClient, office: SeededOffice) =>
  db.clientInvitation.create({
    data: {
      officeId: office.officeId,
      clientId: (await clientIn(db, office)).id,
      email: `iso-invite-${randomUUID()}@example.test`,
      tokenHash: randomUUID(),
      expiresAt: soon(),
      invitedById: office.userId,
    },
  });

/** Client-portal tenant models (D-158), listed here to keep the matrix file short. */
export const PORTAL_RESOURCES: readonly TenantResource[] = [
  { model: 'ClientPortalAccess', create: portalAccessIn, update: { revokedAt: new Date() } },
  { model: 'ClientInvitation', create: clientInvitationIn, update: { status: 'REVOKED' } },
];

/** Billing tenant models (D-162), listed here to keep the matrix file short. */
export const INVOICE_RESOURCES: readonly TenantResource[] = [
  {
    model: 'Invoice',
    create: invoiceIn,
    update: { notes: 'Renamed' },
    http: { list: 'invoices', item: (id) => `invoices/${id}` },
  },
  { model: 'InvoiceLineItem', create: invoiceLineIn, update: { description: 'Renamed' } },
  {
    model: 'InvoiceNumberSequence',
    create: (db, { officeId }) =>
      db.invoiceNumberSequence.create({ data: { officeId, year: 2026, lastValue: 1 } }),
    update: { lastValue: 2 },
  },
];

export const attendanceIn = async (db: PrismaClient, office: SeededOffice) =>
  db.sessionPartyAttendance.create({
    data: {
      officeId: office.officeId,
      sessionId: (await sessionIn(db, office)).id,
      partyId: (await partyIn(db, office)).id,
    },
  });

export const witnessIn = async (db: PrismaClient, office: SeededOffice) =>
  db.witness.create({
    data: {
      officeId: office.officeId,
      fileId: (await fileIn(db, office)).id,
      fullName: 'Isolation witness',
    },
  });

export const statementIn = async (db: PrismaClient, office: SeededOffice) => {
  const witness = await witnessIn(db, office);
  return db.witnessStatement.create({
    data: {
      officeId: office.officeId,
      fileId: witness.fileId,
      witnessId: witness.id,
      statementDate: new Date('2026-01-01T00:00:00Z'),
      text: 'Isolation statement',
      recordedById: office.userId,
    },
  });
};

export const noteIn = async (db: PrismaClient, office: SeededOffice) =>
  db.fileNote.create({
    data: {
      officeId: office.officeId,
      fileId: (await fileIn(db, office)).id,
      authorId: office.userId,
      body: 'Isolation note',
    },
  });
