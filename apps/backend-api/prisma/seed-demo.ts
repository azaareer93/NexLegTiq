import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { seedCourts } from './courts.seed';
import { DEMO_PORTAL_EMAIL, DEMO_STAFF, seedDemoContent } from './demo-content';
import type { PutObject } from './demo-content';
import { DAY, DOMAIN } from './demo-shared';
import { createSeedClient, seedPlans } from './seed';
import { TENANT_MODELS } from '../src/database/tenant-models';
import type { PrismaClient } from '../src/generated/prisma/client';
import type { Role } from '../src/generated/prisma/enums';
import { PasswordHasher } from '../src/modules/auth/password-hasher';

/** Fixed ids so re-running updates the same rows instead of creating new ones. */
export const DEMO_OFFICE_ID = '01920000-0000-7000-8000-000000000001';
export const DEMO_MANAGER_EMAIL = `manager@${DOMAIN}`;
/** Every account the seed owns; reset removes any other user of the demo office (added during a demo). */
export const DEMO_USER_EMAILS = [
  DEMO_MANAGER_EMAIL,
  ...DEMO_STAFF.map(([, key]) => `${key}@${DOMAIN}`),
];

/**
 * The demo office (MVP-118, D-175) for local work, tests, sales demos and E2E: the office, one user per role, the
 * portal client's account, an active Professional subscription and — once — its content (`demo-content.ts`). Every
 * demo account signs in with `DEMO_PASSWORD` when it is set; without it their hash matches no password. Each run puts
 * the accounts back as seeded (role, active, verified, password). `put` uploads the sample PDFs (null: none).
 */
export async function seedDemo(
  prisma: PrismaClient,
  options: { password?: string; put?: PutObject } = {},
): Promise<{ readonly content: boolean }> {
  await seedPlans(prisma);
  await seedCourts(prisma);
  const office = {
    name: 'مكتب المحاماة التجريبي',
    jurisdiction: 'PALESTINE',
    currency: 'ILS',
    email: `office@${DOMAIN}`,
    address: 'رام الله — عنوان تجريبي',
  } as const;
  await prisma.office.upsert({
    where: { id: DEMO_OFFICE_ID },
    create: { id: DEMO_OFFICE_ID, ...office, settings: { create: { taxRatePercent: '16' } } },
    update: office,
  });
  const passwordHash = options.password ? await new PasswordHasher().hash(options.password) : '!';
  const user = async (email: string, fullName: string, role: Role): Promise<string> => {
    const existing = await prisma.user.findUnique({ where: { email }, select: { officeId: true } });
    // Emails are unique across offices: never take over an account someone else registered.
    if (existing && existing.officeId !== DEMO_OFFICE_ID) {
      throw new Error(`${email} belongs to another office; the demo seed will not touch it`);
    }
    const state = { role, isActive: true, emailVerifiedAt: new Date(), passwordHash };
    const row = await prisma.user.upsert({
      where: { email },
      create: { officeId: DEMO_OFFICE_ID, fullName, email, ...state },
      update: state,
    });
    return row.id;
  };
  const managerId = await user(DEMO_MANAGER_EMAIL, 'مدير المكتب التجريبي', 'OFFICE_MANAGER');
  const ids = new Map<string, string>();
  for (const [role, key, fullName] of DEMO_STAFF)
    ids.set(key, await user(`${key}@${DOMAIN}`, fullName, role));
  const id = (key: string) => {
    const value = ids.get(key);
    if (!value) throw new Error(`Demo user ${key} missing`);
    return value;
  };
  const portal = await prisma.clientUser.upsert({
    where: { email: DEMO_PORTAL_EMAIL },
    create: {
      email: DEMO_PORTAL_EMAIL,
      fullName: 'أحمد النموذج (تجريبي)',
      passwordHash,
      emailVerifiedAt: new Date(),
    },
    update: { passwordHash, isActive: true },
  });
  await liveSubscription(prisma);
  const content = await seedDemoContent(
    prisma,
    DEMO_OFFICE_ID,
    {
      managerId,
      lawyers: [id('senior'), id('lawyer1'), id('lawyer2')],
      paralegalId: id('paralegal'),
      portalUserId: portal.id,
    },
    options.put ?? null,
  );
  return { content };
}

async function liveSubscription(prisma: PrismaClient): Promise<void> {
  const live = await prisma.subscription.findFirst({
    where: { officeId: DEMO_OFFICE_ID, status: { in: ['TRIALING', 'ACTIVE'] } },
  });
  if (live) return;
  // Professional, so every demo feature (AI, portal) is on; paid a year ahead.
  const plan =
    (await prisma.plan.findUnique({ where: { code: 'PS_PROFESSIONAL' } })) ??
    (await prisma.plan.findUniqueOrThrow({ where: { code: 'PS_FREE' } }));
  const now = new Date();
  await prisma.subscription.create({
    data: {
      officeId: DEMO_OFFICE_ID,
      planId: plan.id,
      status: 'ACTIVE',
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 365 * DAY),
      paymentMethod: 'NONE',
    },
  });
}

/** Kept by a reset: the office's settings and subscription, and the seed's own users with their terms acceptances. */
const KEPT_ON_RESET = new Set(['OfficeSettings', 'User', 'Subscription', 'LegalAcceptance']);

/**
 * Empties the demo office (never another): every other tenant row of DEMO_OFFICE_ID, children first, and any user of
 * the office the seed does not own (someone added or renamed during a demo). Audit rows can only be deleted by the
 * owner role (the app role may not, D-060): run it with the migration database URL.
 */
export async function resetDemo(prisma: PrismaClient): Promise<void> {
  const where = { officeId: DEMO_OFFICE_ID };
  try {
    await prisma.$transaction(
      async (tx) => {
        for (const model of [...TENANT_MODELS].reverse()) {
          if (KEPT_ON_RESET.has(model)) continue;
          const delegate = (
            tx as unknown as Record<string, { deleteMany?(a: object): Promise<unknown> }>
          )[model.charAt(0).toLowerCase() + model.slice(1)];
          if (!delegate?.deleteMany) throw new Error(`No Prisma delegate for ${model}`);
          await delegate.deleteMany({ where });
        }
        const strangers = { ...where, email: { notIn: DEMO_USER_EMAILS } };
        await tx.legalAcceptance.deleteMany({ where: { ...where, user: strangers } });
        await tx.user.deleteMany({ where: strangers });
      },
      { timeout: 120_000 },
    );
  } catch (error) {
    // 42501 insufficient_privilege: the app role may not delete audit rows.
    if (String((error as { message?: unknown }).message).includes('permission denied')) {
      throw new Error(
        'demo-reset needs the owner (migration) database URL: the app role may not delete audit rows (D-060)',
      );
    }
    throw error;
  }
}

/** Uploads to the configured bucket, or null when no storage is configured (documents are then left out). */
export function s3Put(env: NodeJS.ProcessEnv = process.env): {
  put: PutObject;
  clear: () => Promise<void>;
} {
  const { S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY } = env;
  if (!S3_ENDPOINT || !S3_BUCKET || !S3_ACCESS_KEY_ID || !S3_SECRET_ACCESS_KEY) {
    return { put: null, clear: async () => undefined };
  }
  const client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION ?? 'us-east-1',
    forcePathStyle: env['S3_FORCE_PATH_STYLE'] === 'true',
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY },
  });
  return {
    put: async (key, body) => {
      await client.send(
        new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: key,
          Body: body,
          ContentType: 'application/pdf',
          ...(env['S3_SSE'] === 'AES256' ? { ServerSideEncryption: 'AES256' } : {}),
        }),
      );
    },
    // Only the demo office's prefix: storage keys always start with the office id (D-018).
    clear: async () => {
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: S3_BUCKET,
            Prefix: `${DEMO_OFFICE_ID}/`,
            ContinuationToken: token,
          }),
        );
        const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (keys.length) {
          const result = await client.send(
            new DeleteObjectsCommand({ Bucket: S3_BUCKET, Delete: { Objects: keys } }),
          );
          if (result.Errors?.length)
            throw new Error(`${result.Errors.length} demo objects not deleted`);
        }
        token = page.NextContinuationToken;
      } while (token);
    },
  };
}

/** Development and test, or a demo deployment that says so explicitly (`SEED_DEMO=true`); never production by default. */
export function demoAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnv = env['NODE_ENV'];
  return nodeEnv === 'development' || nodeEnv === 'test' || env['SEED_DEMO'] === 'true';
}

/**
 * Outside development and test (`SEED_DEMO=true`), the database must be a demo deployment of its own: one with an
 * office other than the demo office is refused, so a stray flag on production cannot add publicly known accounts.
 */
export async function assertDemoDatabase(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const nodeEnv = env['NODE_ENV'];
  if (nodeEnv === 'development' || nodeEnv === 'test') return;
  const others = await prisma.office.count({ where: { id: { not: DEMO_OFFICE_ID } } });
  if (others > 0)
    throw new Error('SEED_DEMO=true on a database with real offices: refused (D-175)');
}

async function main(): Promise<void> {
  if (!demoAllowed()) {
    throw new Error(
      'seed-demo runs only with NODE_ENV=development|test, or SEED_DEMO=true on a demo tenant',
    );
  }
  const prisma = createSeedClient();
  const storage = s3Put();
  try {
    await assertDemoDatabase(prisma);
    if (process.argv.includes('--reset')) {
      await resetDemo(prisma);
      await storage.clear();
      console.info('Demo office emptied');
    }
    const password = process.env['DEMO_PASSWORD'];
    const { content } = await seedDemo(prisma, {
      ...(password ? { password } : {}),
      put: storage.put,
    });
    console.info(
      content
        ? 'Seeded demo office'
        : 'Demo office already has content (use demo-reset to rebuild)',
    );
    if (!password) console.info('DEMO_PASSWORD not set: demo users cannot sign in');
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
