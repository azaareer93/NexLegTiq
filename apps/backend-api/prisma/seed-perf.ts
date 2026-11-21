import { seedCourts } from './courts.seed';
import { createSeedClient, seedPlans } from './seed';
import { Prisma } from '../src/generated/prisma/client';
import type { PrismaClient } from '../src/generated/prisma/client';
import type { Role } from '../src/generated/prisma/enums';
import { PasswordHasher } from '../src/modules/auth/password-hasher';

/**
 * Load-test data (MVP-117, D-235): `PERF_OFFICES` offices (20), each with 1k clients, 5k files, 20k READY documents with
 * text, 10k tasks, 2k hearings and the timeline of its files and documents — written with `generate_series`, so the
 * search triggers and indexes do their real work. Every account signs in with `PERF_PASSWORD`; emails are
 * `perf-oNN-<key>@perf.nexlegtiq.test` (perf/baseline.js reads the same pattern). Development and test only, on the
 * database named by `PERF_DATABASE_URL` (`pnpm perf:db`); one that already holds perf offices is refused.
 */
const DOMAIN = 'perf.nexlegtiq.test';
const PERF_STAFF: readonly (readonly [Role, string])[] = [
  ['OFFICE_MANAGER', 'manager'],
  ['SENIOR_LAWYER', 'senior'],
  ['LAWYER', 'lawyer1'],
  ['LAWYER', 'lawyer2'],
  ['LAWYER', 'lawyer3'],
  ['PARALEGAL', 'paralegal'],
];
const PERF_SIZES = {
  clients: 1_000,
  files: 5_000,
  documents: 20_000,
  tasks: 10_000,
  sessions: 2_000,
} as const;

const perfEmail = (office: number, key: string): string =>
  `perf-o${String(office).padStart(2, '0')}-${key}@${DOMAIN}`;

// A word from a real Arabic/English vocabulary a third of the time, else one of 2,000 others (offices name things
// differently; a dozen words everywhere would match a quarter of every table). Constant SQL, no input: Prisma.raw is safe.
const WORDS = `ARRAY['عقد','إيجار','دعوى','المدرسة','أحمد','شركة','النور','عمل','ميراث','أرض','بيع','تعويض','lease','contract','claim','estate','damages','appeal']`;
const WORD = `(CASE WHEN random() < 0.33 THEN (${WORDS})[1 + floor(random() * 18)::int] ELSE 'كلمة' || floor(random() * 2000)::int END)`;
const TITLE = Prisma.raw(`concat_ws(' ', ${WORD}, ${WORD}, ${WORD})`);
// About 80 words of document text; `g` (the row's number) correlates the subquery, so each row gets its own text.
const TEXT = Prisma.raw(`(SELECT string_agg(${WORD}, ' ') FROM generate_series(1, 80 + g % 2))`);

function perfAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['NODE_ENV'] === 'development' || env['NODE_ENV'] === 'test';
}

/** One office and its rows; returns the office id. */
async function seedPerfOffice(
  prisma: PrismaClient,
  index: number,
  passwordHash: string,
  planId: string,
): Promise<string> {
  const office = await prisma.office.create({
    data: { name: `Perf office ${index}`, settings: { create: {} } },
  });
  const officeId = office.id;
  const users: Record<string, string> = {};
  for (const [role, key] of PERF_STAFF) {
    const user = await prisma.user.create({
      data: {
        officeId,
        role,
        fullName: `${key} ${index}`,
        email: perfEmail(index, key),
        passwordHash,
        emailVerifiedAt: new Date(),
      },
    });
    users[key] = user.id;
  }
  const now = new Date();
  await prisma.subscription.create({
    data: {
      officeId,
      planId,
      status: 'ACTIVE',
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 365 * 86_400_000),
    },
  });
  const lawyers = [users['senior'], users['lawyer1'], users['lawyer2'], users['lawyer3']];
  const lawyerArray = Prisma.sql`ARRAY[${Prisma.join(lawyers)}]::uuid[]`;
  const everyone = Prisma.sql`ARRAY[${Prisma.join(Object.values(users))}]::uuid[]`;
  const o = Prisma.sql`${officeId}::uuid`;
  const s = PERF_SIZES;

  await prisma.$executeRaw`SELECT setseed(${index / 100})`;
  await prisma.$executeRaw`
    INSERT INTO clients (id, office_id, client_type, display_name, updated_at)
    SELECT nlq_uuid_v7(), ${o}, 'INDIVIDUAL', ${TITLE}, now() FROM generate_series(1, ${s.clients}) g`;
  // Files: a quarter per lawyer, one in five closed, one in fifty confidential, opened over three years.
  await prisma.$executeRaw`
    INSERT INTO legal_files (id, office_id, file_number, title, file_type, status, responsible_lawyer_id,
                             responsible_paralegal_id, jurisdiction, currency, is_confidential, opening_date,
                             created_at, updated_at)
    SELECT nlq_uuid_v7(), ${o}, 'P-' || lpad(g::text, 5, '0'), ${TITLE},
           (ARRAY['LITIGATION','RENTAL_AGREEMENT','CONTRACT_DRAFTING','LEGAL_ADVISORY']::"FileType"[])[1 + g % 4],
           CASE WHEN g % 5 = 0 THEN 'CLOSED' ELSE 'OPEN' END::"FileStatus",
           (${lawyerArray})[1 + g % 4], CASE WHEN g % 3 = 0 THEN ${users['paralegal']}::uuid END,
           'PALESTINE', 'ILS', g % 50 = 0, (now() - (g % 1095) * interval '1 day')::date,
           now() - (g % 1095) * interval '1 day', now() - (g % 90) * interval '1 day'
    FROM generate_series(1, ${s.files}) g`;
  await prisma.$transaction(
    async (tx) => {
      // Files numbered once, so every child picks its file by `g % files`.
      await tx.$executeRaw`
        CREATE TEMP TABLE perf_files ON COMMIT DROP AS
        SELECT row_number() OVER (ORDER BY id) - 1 AS n, id, responsible_lawyer_id AS lawyer
        FROM legal_files WHERE office_id = ${o}`;
      await tx.$executeRaw`CREATE INDEX ON perf_files (n)`;
      await tx.$executeRaw`
        INSERT INTO file_clients (id, office_id, file_id, client_id, is_primary, updated_at)
        SELECT nlq_uuid_v7(), ${o}, f.id, c.id, true, now()
        FROM perf_files f
        JOIN (SELECT row_number() OVER (ORDER BY id) - 1 AS n, id FROM clients WHERE office_id = ${o}) c
          ON c.n = f.n % ${s.clients}`;
      await tx.$executeRaw`
        INSERT INTO case_timeline_events (id, office_id, file_id, event_type, actor_id, occurred_at, payload)
        SELECT nlq_uuid_v7(), ${o}, f.id, 'FILE_OPENED', f.lawyer, now() - (f.n % 1095) * interval '1 day', '{}'
        FROM perf_files f`;
      // Documents: one in ten uploaded in the last week (the dashboard's "new documents"), one in thirty confidential.
      await tx.$executeRaw`
        CREATE TEMP TABLE perf_docs ON COMMIT DROP AS
        SELECT nlq_uuid_v7() AS id, f.id AS file_id, f.lawyer, g,
               now() - (CASE WHEN g % 10 = 0 THEN g % 7 ELSE g % 720 END) * interval '1 day'
                 - (g % 1440) * interval '1 minute' AS at
        FROM generate_series(1, ${s.documents}) g JOIN perf_files f ON f.n = g % ${s.files}`;
      await tx.$executeRaw`
        INSERT INTO documents (id, office_id, file_id, name, original_filename, document_type, mime_type, size_bytes,
                               checksum_sha256, storage_key, status, ocr_status, language, is_confidential,
                               uploaded_by_id, created_at, updated_at)
        SELECT d.id, ${o}, d.file_id, 'document-' || d.g || '.pdf', 'document-' || d.g || '.pdf', 'OTHER',
               'application/pdf', 40000 + d.g % 50000, md5(d.id::text) || md5(d.g::text),
               ${officeId} || '/' || d.file_id || '/' || d.id || '/v1.pdf', 'READY', 'NOT_NEEDED', 'MIXED',
               d.g % 30 = 0, d.lawyer, d.at, d.at
        FROM perf_docs d`;
      await tx.$executeRaw`
        INSERT INTO document_versions (id, office_id, document_id, version_number, storage_key, original_filename,
                                       mime_type, size_bytes, checksum_sha256, created_by_id, created_at)
        SELECT nlq_uuid_v7(), ${o}, d.id, 1, ${officeId} || '/' || d.file_id || '/' || d.id || '/v1.pdf',
               'document-' || d.g || '.pdf', 'application/pdf', 40000 + d.g % 50000,
               md5(d.id::text) || md5(d.g::text), d.lawyer, d.at
        FROM perf_docs d`;
      await tx.$executeRaw`
        INSERT INTO document_texts (id, office_id, document_id, version_number, text, page_count, updated_at)
        SELECT nlq_uuid_v7(), ${o}, d.id, 1, ${TEXT}, 1 + d.g % 5, now()
        FROM perf_docs d`;
      await tx.$executeRaw`
        INSERT INTO case_timeline_events (id, office_id, file_id, event_type, source_type, source_id, actor_id,
                                          occurred_at, payload)
        SELECT nlq_uuid_v7(), ${o}, d.file_id, 'DOCUMENT_UPLOADED', 'Document', d.id, d.lawyer, d.at,
               jsonb_build_object('name', 'document-' || d.g || '.pdf', 'versionNumber', 1)
        FROM perf_docs d`;
      // Tasks: four in five on a file, the rest personal; due over ±60 days; a third done.
      await tx.$executeRaw`
        INSERT INTO tasks (id, office_id, file_id, title, due_date, status, assigned_to_id, created_by_id,
                           completed_at, updated_at)
        SELECT nlq_uuid_v7(), ${o}, CASE WHEN g % 5 <> 0 THEN f.id END, ${TITLE},
               (now() + ((g % 121) - 60) * interval '1 day')::date,
               (ARRAY['TODO','IN_PROGRESS','DONE']::"TaskStatus"[])[1 + g % 3],
               (${everyone})[1 + g % ${PERF_STAFF.length}], ${users['manager']}::uuid,
               CASE WHEN g % 3 = 2 THEN now() END, now()
        FROM generate_series(1, ${s.tasks}) g JOIN perf_files f ON f.n = g % ${s.files}`;
      // Hearings from 180 days ago to 30 ahead, on the hour, by the file's lawyer; a few today.
      await tx.$executeRaw`
        INSERT INTO sessions (id, office_id, file_id, starts_at, attending_lawyer_id, created_by_id, updated_at)
        SELECT nlq_uuid_v7(), ${o}, f.id,
               date_trunc('day', now()) + ((g % 211) - 180) * interval '1 day' + (8 + g % 8) * interval '1 hour',
               f.lawyer, f.lawyer, now()
        FROM generate_series(1, ${s.sessions}) g JOIN perf_files f ON f.n = (g * 7) % ${s.files}`;
    },
    { timeout: 900_000, maxWait: 10_000 },
  );
  return officeId;
}

async function main(): Promise<void> {
  if (!perfAllowed()) throw new Error('seed-perf runs only with NODE_ENV=development|test');
  const password = process.env['PERF_PASSWORD'];
  if (!password || password.length < 12)
    throw new Error('Set PERF_PASSWORD (12+ characters) for the perf accounts');
  const offices = Number(process.env['PERF_OFFICES'] ?? 20);
  // Its own variable, never DATABASE_URL: Nx loads the developer's .env, which names the dev database.
  const url = process.env['PERF_DATABASE_URL'];
  if (!url) throw new Error('Set PERF_DATABASE_URL to the perf database (docs/perf/baseline.md)');
  process.env['DATABASE_URL'] = url;
  const prisma = createSeedClient();
  try {
    if (await prisma.user.count({ where: { email: { endsWith: `@${DOMAIN}` } } }))
      throw new Error('This database already holds perf offices: use a fresh one (pnpm perf:db)');
    await seedPlans(prisma);
    await seedCourts(prisma);
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: 'PS_PROFESSIONAL' } });
    const passwordHash = await new PasswordHasher().hash(password);
    for (let index = 1; index <= offices; index += 1) {
      const started = Date.now();
      await seedPerfOffice(prisma, index, passwordHash, plan.id);
      console.info(
        `Perf office ${index}/${offices} seeded in ${Math.round((Date.now() - started) / 1000)} s`,
      );
    }
    await prisma.$executeRaw`ANALYZE`;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
