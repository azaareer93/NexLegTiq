import { randomUUID } from 'node:crypto';

import type { SeededOffice } from './tenant-isolation.matrix';
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
