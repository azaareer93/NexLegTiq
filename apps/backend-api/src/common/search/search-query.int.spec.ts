import { randomUUID } from 'node:crypto';

import { searchQuery } from './search-query';
import type { SearchHit, SearchTarget } from './search-query';
import { createSeedClient } from '../../../prisma/seed';
import { documentTextIn, statementIn } from '../../database/tenant-isolation.fixtures';
import { Prisma } from '../../generated/prisma/client';
import type { PrismaClient } from '../../generated/prisma/client';

const ROLLBACK = new Error('rollback');

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
        (await tx.$queryRaw<SearchHit[]>(searchQuery(target, officeId, query, 10))).map(
          (hit) => hit.id,
        );
      const got = {
        q0: await ids('files', 'احمد المدرسه'), // أ → ا, ة → ه
        q1: await ids('files', '2026-LIT-00042'),
        q2: await ids('files', 'agreement'), // English stem of "agreements"
        q3: await ids('files', '"lease dispute" -school'), // websearch syntax: phrase
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
        q3: [],
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
        searchQuery('clients', a.officeId, 'شركة النور', 10),
      );
      expect(hits[0]?.id).toBe(both.id);
      const only = await tx.$queryRaw<SearchHit[]>(
        searchQuery('clients', a.officeId, 'شركة', 1, Prisma.sql`t."id" = ${one.id}::uuid`),
      );
      expect(only.map((hit) => hit.id)).toEqual([one.id]);
    });
  });
});
