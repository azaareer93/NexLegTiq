import { randomBytes } from 'node:crypto';

import { createSeedClient } from './seed';
import { PasswordHasher } from '../src/modules/auth/password-hasher';

/**
 * Creates a platform admin (D-145) — the only way one comes to exist (no public signup). Run by an operator:
 *   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" pnpm nx run backend-api:create-admin
 * against the database in DATABASE_URL (the migrator's URL in production). It prints a random first password once;
 * the admin sets up the authenticator at first sign-in. An existing email is refused, never overwritten.
 */
async function main(): Promise<void> {
  const email = process.env['ADMIN_EMAIL']?.trim().toLowerCase();
  const fullName = process.env['ADMIN_NAME']?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !fullName) {
    throw new Error('Set ADMIN_EMAIL (an email address) and ADMIN_NAME');
  }
  const password = randomBytes(18).toString('base64url');
  const prisma = createSeedClient();
  try {
    const existing = await prisma.platformAdmin.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) throw new Error(`A platform admin with ${email} already exists`);
    const admin = await prisma.platformAdmin.create({
      data: { email, fullName, passwordHash: await new PasswordHasher().hash(password) },
      select: { id: true },
    });
    console.info(`Platform admin ${email} created (${admin.id}).`);
    console.info(`First password (shown once, keep it in your password manager): ${password}`);
    console.info('Sign in to the admin panel to set up the authenticator app.');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
