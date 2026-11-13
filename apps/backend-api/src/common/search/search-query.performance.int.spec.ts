import { randomUUID } from 'node:crypto';

import { searchQuery } from './search-query';
import type { SearchTarget } from './search-query';
import { createSeedClient } from '../../../prisma/seed';
import { Prisma } from '../../generated/prisma/client';
import type { PrismaClient } from '../../generated/prisma/client';

const ROWS = 50_000;
const RUNS = 20;
/** MVP-80 budget: P95 < 200 ms per search query with 50k rows per office (D-165). */
const BUDGET_MS = 200;
const ROLLBACK = new Error('rollback');

/** Search stays inside its budget with 50k files, clients and tasks in one office (MVP-80). */
describe('searchQuery with 50k rows per table (performance)', () => {
  let prisma: PrismaClient;
  beforeAll(() => {
    prisma = createSeedClient();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it(`should answer every target within ${BUDGET_MS} ms (P95 of ${RUNS})`, async () => {
    const timings: Record<string, number> = {};
    await expect(
      prisma.$transaction(
        async (tx) => {
          const officeId = (await tx.office.create({ data: { name: 'Search performance' } })).id;
          const userId = (
            await tx.user.create({
              data: {
                officeId,
                fullName: 'Perf',
                email: `perf-${randomUUID()}@example.test`,
                passwordHash: '!',
                role: 'OFFICE_MANAGER',
              },
            })
          ).id;
          // Titles of three words, reproducibly: a third from real Arabic/English words, the rest from 2,000 others (names
          // and subjects vary in a real office; a dozen words in every row would match a quarter of the table).
          await tx.$executeRaw`SELECT setseed(0.42)`;
          const words = `ARRAY['عقد','إيجار','دعوى','المدرسة','أحمد','شركة','النور','عمل','ميراث','lease','contract','claim']`;
          const pick = `(CASE WHEN random() < 0.33 THEN (${words})[1 + floor(random() * 12)::int] ELSE 'كلمة' || floor(random() * 2000)::int END)`;
          const title = `concat_ws(' ', ${pick}, ${pick}, ${pick}, g)`;
          // A constant expression (no input): Prisma.raw is safe here.
          const text = Prisma.raw(title);
          await tx.$executeRaw`
              INSERT INTO legal_files (id, office_id, file_number, title, file_type, responsible_lawyer_id,
                                       jurisdiction, currency, updated_at)
              SELECT nlq_uuid_v7(), ${officeId}::uuid, 'PERF-' || g, ${text}, 'LITIGATION', ${userId}::uuid,
                     'PALESTINE', 'ILS', now()
              FROM generate_series(1, ${ROWS}) g`;
          await tx.$executeRaw`
              INSERT INTO clients (id, office_id, client_type, display_name, updated_at)
              SELECT nlq_uuid_v7(), ${officeId}::uuid, 'CORPORATION', ${text}, now()
              FROM generate_series(1, ${ROWS}) g`;
          await tx.$executeRaw`
              INSERT INTO tasks (id, office_id, title, assigned_to_id, created_by_id, updated_at)
              SELECT nlq_uuid_v7(), ${officeId}::uuid, ${text}, ${userId}::uuid, ${userId}::uuid, now()
              FROM generate_series(1, ${ROWS}) g`;
          await tx.$executeRaw`ANALYZE legal_files, clients, tasks`;

          const cases: [SearchTarget, string][] = [
            ['files', 'احمد المدرسه'],
            ['files', 'عقد ايجار'],
            ['files', 'lease contract'],
            ['clients', 'شركه النور'],
            ['clients', 'النوور'], // a typo: trigram fallback
            ['tasks', 'claims'],
          ];
          for (const [target, query] of cases) {
            const run = () => tx.$queryRaw(searchQuery(target, officeId, query, 20));
            await run(); // plans warm
            const samples: number[] = [];
            for (let i = 0; i < RUNS; i += 1) {
              const started = performance.now();
              await run();
              samples.push(performance.now() - started);
            }
            samples.sort((x, y) => x - y);
            timings[`${target} "${query}"`] = samples[Math.ceil(RUNS * 0.95) - 1] ?? Infinity;
          }
          throw ROLLBACK;
        },
        { timeout: 600_000, maxWait: 10_000 },
      ),
    ).rejects.toBe(ROLLBACK);
    // Printed for the PR description (D-165 records the numbers).
    process.stdout.write(`search P95 (ms): ${JSON.stringify(timings)}\n`);
    for (const p95 of Object.values(timings)) expect(p95).toBeLessThan(BUDGET_MS);
  }, 900_000);
});
