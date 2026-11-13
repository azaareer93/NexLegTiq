import { randomUUID } from 'node:crypto';

import { searchQuery } from './search-query';
import type { SearchHit, SearchTarget } from './search-query';
import { createSeedClient } from '../../../prisma/seed';
import {
  clientIn,
  documentTextIn,
  fileIn,
  partyIn,
  statementIn,
} from '../../database/tenant-isolation.fixtures';
import { Prisma } from '../../generated/prisma/client';
import type { PrismaClient } from '../../generated/prisma/client';

const ROLLBACK = new Error('rollback');
const ALL = Prisma.sql`true`;

/** Runs `body` in a transaction that is always rolled back, so the test leaves no rows behind. */
async function inRollback(
  prisma: PrismaClient,
  body: (tx: PrismaClient) => Promise<void>,
  timeout = 10_000,
): Promise<void> {
  await expect(
    prisma.$transaction(
      async (tx) => {
        await body(tx as unknown as PrismaClient);
        throw ROLLBACK;
      },
      { timeout, maxWait: timeout },
    ),
  ).rejects.toBe(ROLLBACK);
}

async function office(tx: PrismaClient) {
  const officeId = (await tx.office.create({ data: { name: 'Search office' } })).id;
  const user = await tx.user.create({
    data: {
      officeId,
      fullName: 'Searcher',
      email: `search-${randomUUID()}@example.test`,
      passwordHash: '!',
      role: 'OFFICE_MANAGER',
    },
  });
  return { officeId, userId: user.id, planId: '' };
}

/** Arabic-aware search on real PostgreSQL (MVP-80, D-165). */
describe('searchQuery (PostgreSQL)', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = createSeedClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('should find Arabic regardless of hamza, ta-marbuta and tashkeel, English by stem, and never another office', async () => {
    await inRollback(prisma, async (tx) => {
      const a = await office(tx);
      const b = await office(tx);
      const file = await tx.legalFile.create({
        data: {
          officeId: a.officeId,
          fileNumber: '2026-LIT-00042',
          title: 'دعوى أحمد ضد المدرسة',
          description: 'Lease agreements dispute',
          fileType: 'LITIGATION',
          responsibleLawyerId: a.userId,
          jurisdiction: 'PALESTINE',
          currency: 'ILS',
        },
      });
      const client = await tx.client.create({
        data: { officeId: a.officeId, clientType: 'INDIVIDUAL', displayName: 'إحمد السالم' },
      });
      const party = await tx.party.create({
        data: { officeId: a.officeId, isIndividual: true, fullName: 'مُحَمَّد خليل' },
      });
      const task = await tx.task.create({
        data: {
          officeId: a.officeId,
          title: 'Review the lease',
          assignedToId: a.userId,
          createdById: a.userId,
        },
      });
      const text = await documentTextIn(tx, a);
      await tx.documentText.update({
        where: { id: text.id },
        data: { text: 'قرار المحكمة بشأن عقد الإيجار' },
      });
      const statement = await statementIn(tx, a);
      await tx.witnessStatement.update({
        where: { id: statement.id },
        data: { text: 'شاهدتُ توقيع العقد' },
      });
      // The same words in another office.
      await tx.client.create({
        data: { officeId: b.officeId, clientType: 'INDIVIDUAL', displayName: 'احمد السالم' },
      });

      const ids = async (target: SearchTarget, query: string, officeId = a.officeId) =>
        (await tx.$queryRaw<SearchHit[]>(searchQuery(target, officeId, query, 10, ALL))).map(
          (hit) => hit.id,
        );
      const got = {
        q0: await ids('files', 'احمد المدرسه'), // أ → ا, ة → ه
        q1: await ids('files', '2026-LIT-00042'),
        q2: await ids('files', 'agreement'), // English stem of "agreements"
        q3: await ids('files', '"lease agreements"'), // websearch syntax: a phrase
        q3b: await ids('files', 'lease -dispute'), // and a negation
        q3c: await ids('files', '"agreements lease"'), // words out of order are not the phrase
        q12: await ids('files', 'أحمد'),
        q13: await ids('files', 'إحمد'),
        q14: await ids('files', 'المدرسة'), // ة and ه alike
        q15: await ids('files', 'المدرسه'),
        q16: await ids('parties', 'مُحَمَّد'), // tashkeel in the query too
        q4: await ids('clients', 'احمد'), // إ → ا; office B's client not seen
        q5: await ids('clients', 'احمد', b.officeId),
        q6: await ids('clients', 'السالن'), // a typo: trigram fallback
        q7: await ids('parties', 'محمد'), // tashkeel stripped
        q8: await ids('tasks', 'lease reviewing'), // mixed stems
        q9: await ids('documents', 'الايجار'),
        q10: await ids('statements', 'شاهدت'),
        q11: await ids('files', 'nothing like it'),
      };
      expect(got).toEqual({
        q0: [file.id],
        q1: [file.id],
        q2: [file.id],
        q3: [file.id],
        q3b: [],
        q3c: [],
        q12: [file.id],
        q13: [file.id],
        q14: [file.id],
        q15: [file.id],
        q16: [party.id],
        q4: [client.id],
        q5: [expect.any(String)],
        q6: [client.id],
        q7: [party.id],
        q8: [task.id],
        q9: [text.id],
        q10: [statement.id],
        q11: [],
      });
    });
  });

  it('should follow renames on every table and backfill vectors that were emptied', async () => {
    await inRollback(prisma, async (tx) => {
      const a = await office(tx);
      const file = await fileIn(tx, a);
      const client = await clientIn(tx, a);
      const party = await partyIn(tx, a);
      const task = await tx.task.create({
        data: { officeId: a.officeId, title: 'x', assignedToId: a.userId, createdById: a.userId },
      });
      await tx.legalFile.update({ where: { id: file.id }, data: { title: 'ميراث العائلة' } });
      await tx.client.update({ where: { id: client.id }, data: { displayName: 'مؤسسة القدس' } });
      await tx.party.update({ where: { id: party.id }, data: { fullName: 'يوسف عيسى' } });
      await tx.task.update({ where: { id: task.id }, data: { description: 'Draft the appeal' } });
      const ids = async (target: SearchTarget, query: string) =>
        (await tx.$queryRaw<SearchHit[]>(searchQuery(target, a.officeId, query, 10, ALL))).map(
          (hit) => hit.id,
        );
      expect({
        file: await ids('files', 'ميراث'),
        client: await ids('clients', 'القدس'),
        party: await ids('parties', 'يوسف'),
        task: await ids('tasks', 'appeals'),
        old: await ids('files', 'Isolation'),
      }).toEqual({
        file: [file.id],
        client: [client.id],
        party: [party.id],
        task: [task.id],
        old: [],
      });
      // The migration's backfill: naming a vector in SET recomputes both from the row.
      await tx.$executeRaw`UPDATE clients SET search_vector_simple = NULL WHERE id = ${client.id}::uuid`;
      const [row] = await tx.$queryRaw<{ simple: boolean; english: boolean }[]>`
        SELECT search_vector_simple IS NOT NULL AS simple, search_vector_english IS NOT NULL AS english
        FROM clients WHERE id = ${client.id}::uuid`;
      expect(row).toEqual({ simple: true, english: true });
    });
  });

  it('should refuse a limit outside 1 to 100', () => {
    expect(() => searchQuery('files', 'o', 'x', 0, ALL)).toThrow(RangeError);
    expect(() => searchQuery('files', 'o', 'x', 1.5, ALL)).toThrow(RangeError);
  });

  it('should rank the closer match first and apply the extra condition before the limit', async () => {
    await inRollback(prisma, async (tx) => {
      const a = await office(tx);
      const make = (displayName: string) =>
        tx.client.create({
          data: { officeId: a.officeId, clientType: 'CORPORATION', displayName },
        });
      const both = await make('شركة النور للتجارة');
      const one = await make('شركة الأمل');
      const hits = await tx.$queryRaw<SearchHit[]>(
        searchQuery('clients', a.officeId, 'شركة النور', 10, ALL),
      );
      expect(hits[0]?.id).toBe(both.id);
      const only = await tx.$queryRaw<SearchHit[]>(
        searchQuery('clients', a.officeId, 'شركة', 1, Prisma.sql`t."id" = ${one.id}::uuid`),
      );
      expect(only.map((hit) => hit.id)).toEqual([one.id]);
    });
  });
});
