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
