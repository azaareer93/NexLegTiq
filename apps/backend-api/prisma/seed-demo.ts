import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { seedCourts } from './courts.seed';
import { DEMO_PORTAL_EMAIL, DEMO_STAFF, seedDemoContent } from './demo-content';
import type { PutObject } from './demo-content';
import { createSeedClient, seedPlans } from './seed';
import { TENANT_MODELS } from '../src/database/tenant-models';
import type { PrismaClient } from '../src/generated/prisma/client';
import { PasswordHasher } from '../src/modules/auth/password-hasher';

/** Fixed ids so re-running updates the same rows instead of creating new ones. */
export const DEMO_OFFICE_ID = '01920000-0000-7000-8000-000000000001';
export const DEMO_MANAGER_EMAIL = 'manager@demo.nexlegtiq.test';
const DOMAIN = 'demo.nexlegtiq.test';

/**
 * The demo office (MVP-118, D-175) for local work, tests, sales demos and E2E: the office, one user per role, an active
 * Professional subscription and — once — its content (`demo-content.ts`). Users sign in with `DEMO_PASSWORD` when it is
 * set; without it their hash matches no password. `put` uploads the sample PDFs (null: no documents).
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
  const user = async (email: string, fullName: string, role: string) =>
    (
      await prisma.user.upsert({
        where: { email },
        create: {
          officeId: DEMO_OFFICE_ID,
          fullName,
          email,
          passwordHash,
          role: role as never,
          emailVerifiedAt: new Date(),
        },
        // A changed DEMO_PASSWORD takes effect on the next run; names and roles stay as they are.
        update: options.password ? { passwordHash } : {},
      })
    ).id;
  const managerId = await user(DEMO_MANAGER_EMAIL, 'مدير المكتب التجريبي', 'OFFICE_MANAGER');
  const ids: Record<string, string> = {};
  for (const [role, key, fullName] of DEMO_STAFF) {
    ids[key] = await user(`${key}@${DOMAIN}`, fullName, role);
  }
  await liveSubscription(prisma);
  const content = await seedDemoContent(
    prisma,
    DEMO_OFFICE_ID,
    {
      managerId,
      lawyers: [ids['senior'], ids['lawyer1'], ids['lawyer2']] as string[],
      paralegalId: ids['paralegal'] as string,
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
      currentPeriodEnd: new Date(now.getTime() + 365 * 86_400_000),
      paymentMethod: 'NONE',
    },
  });
}

/**
 * Empties the demo office (never another): every tenant row of DEMO_OFFICE_ID, children first, and the portal user;
 * the office, its settings, users and subscription are kept for the next seed. Audit rows can only be deleted by the
 * owner role (the app role may not, D-060): run it with the migration database URL.
 */
export async function resetDemo(prisma: PrismaClient): Promise<void> {
  const keep = new Set(['OfficeSettings', 'User', 'Subscription']);
  await prisma.$transaction(async (tx) => {
    for (const model of [...TENANT_MODELS].reverse()) {
      if (keep.has(model)) continue;
      const delegate = (
        tx as unknown as Record<string, { deleteMany(a: object): Promise<unknown> }>
      )[model.charAt(0).toLowerCase() + model.slice(1)];
      await delegate?.deleteMany({ where: { officeId: DEMO_OFFICE_ID } });
    }
    await tx.fileNumberSequence.deleteMany({ where: { officeId: DEMO_OFFICE_ID } });
    await tx.clientUser.deleteMany({ where: { email: DEMO_PORTAL_EMAIL } });
  });
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
          await client.send(
            new DeleteObjectsCommand({ Bucket: S3_BUCKET, Delete: { Objects: keys } }),
          );
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

async function main(): Promise<void> {
  if (!demoAllowed()) {
    throw new Error(
      'seed-demo runs only with NODE_ENV=development|test, or SEED_DEMO=true on a demo tenant',
    );
  }
  const prisma = createSeedClient();
  const storage = s3Put();
  try {
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
