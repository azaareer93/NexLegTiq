import { randomUUID } from 'node:crypto';

import { Module } from '@nestjs/common';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { OfficeId } from '@nexlegtiq/shared-types';

import { hashOpaqueToken } from '../common/auth/opaque-token';
import { CoreModule } from '../common/core/core.module';
import { MailModule } from '../common/mail/mail.module';
import { MailService } from '../common/mail/mail.service';
import { QueueModule } from '../common/queue/queue.module';
import { QueueProducer } from '../common/queue/queue-producer';
import { QUEUE, QUEUE_NAMES } from '../common/queue/queues';
import { drainQueue, getQueue } from '../common/queue/testing';
import { TenantRunner } from '../common/tenancy/tenant-runner';
import { integrationEnv } from '../config/env.fixture';
import { DatabaseModule } from '../database/database.module';
import { PrismaService } from '../database/prisma.service';
import { SEND_PASSWORD_RESET_JOB, SEND_VERIFICATION_EMAIL_JOB } from '../modules/auth/account-mailer';
import { PasswordResetLinks } from '../modules/auth/password-reset-links';
import { VerificationLinks } from '../modules/auth/verification-links';
import { EmailProcessor } from './email.processor';

const MAILPIT = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';

interface MailpitMessage {
  readonly Subject: string;
  readonly HTML: string;
  readonly Text: string;
}

/** Waits for the message Mailpit received for `to` (the worker sends asynchronously). */
async function receivedBy(to: string): Promise<MailpitMessage> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const search = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()) as {
      messages: { ID: string }[];
    };
    const id = search.messages[0]?.ID;
    if (id) return (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as MailpitMessage;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No email for ${to}`);
}

/** Like WorkerModule: the email processor with real Redis, PostgreSQL and SMTP (Mailpit). */
@Module({
  imports: [CoreModule, DatabaseModule, QueueModule, MailModule],
  providers: [EmailProcessor, VerificationLinks, PasswordResetLinks],
})
class EmailTestModule {}

/** MVP-35: email jobs rendered in AR/EN and delivered through SMTP to Mailpit; verification links issued by the worker. */
describe('email worker (Redis + PostgreSQL + Mailpit)', () => {
  let app: INestApplicationContext;
  let officeId: OfficeId;
  const savedEnv = { ...process.env };
  const inOffice = <T>(work: () => Promise<T>) => app.get(TenantRunner).run({ officeId }, work);
  const queue = () => getQueue(app, QUEUE.EMAIL);

  beforeAll(async () => {
    Object.assign(process.env, integrationEnv({ BULLMQ_PREFIX: `it-${randomUUID().slice(0, 8)}`, OFFICE_APP_URL: 'https://app.example.test' }));
    app = await (await Test.createTestingModule({ imports: [EmailTestModule] }).compile()).init();
    // unscoped: test setup.
    officeId = (await app.get(PrismaService).unscoped().office.create({ data: { name: 'Email test office' } })).id as OfficeId;
  });

  afterAll(async () => {
    if (app) {
      for (const name of QUEUE_NAMES) await getQueue(app, name).obliterate({ force: true });
      // unscoped: test cleanup.
      const raw = app.get(PrismaService).unscoped();
      await raw.emailVerificationToken.deleteMany({ where: { officeId } });
      await raw.passwordResetToken.deleteMany({ where: { officeId } });
      await raw.user.deleteMany({ where: { officeId } });
      await raw.office.delete({ where: { id: officeId } });
      await app.close();
    }
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  });

  async function createUser(uiLanguage: 'AR' | 'EN') {
    const email = `mail-${randomUUID()}@example.test`;
    // unscoped: test setup.
    const user = await app.get(PrismaService).unscoped().user.create({
      data: { officeId, fullName: 'عمر المصري', email, passwordHash: '!', role: 'OFFICE_MANAGER', uiLanguage },
    });
    return { id: user.id, email };
  }

  it('should issue a verification link in the worker and send it in Arabic, right to left', async () => {
    const user = await createUser('AR');
    await inOffice(() => app.get(QueueProducer).enqueue(QUEUE.EMAIL, SEND_VERIFICATION_EMAIL_JOB, { userId: user.id }));
    await drainQueue(queue());

    const mail = await receivedBy(user.email);
    expect(mail.Subject).toBe('تأكيد بريدك الإلكتروني في NexLegTiq');
    expect(mail.HTML).toContain('dir="rtl"');
    expect(mail.HTML).toContain('lang="ar"');
    const link = /https:\/\/app\.example\.test\/verify-email\?token=([A-Za-z0-9_-]{43})/.exec(mail.Text);
    expect(link).not.toBeNull();

    // The job carried only the user id; the stored link is the hash of the emailed token.
    const jobs = await queue().getJobs(['completed']);
    expect(JSON.stringify(jobs.map((job) => job.data))).not.toContain(link?.[1] ?? 'missing');
    // unscoped: test assertion.
    const stored = await app.get(PrismaService).unscoped().emailVerificationToken.findFirstOrThrow({ where: { userId: user.id, usedAt: null } });
    expect(stored.tokenHash).toBe(hashOpaqueToken(link?.[1] ?? ''));
  });

  it('should send English users an English, left-to-right link that lasts 7 days', async () => {
    const user = await createUser('EN');
    const before = Date.now();
    await inOffice(() => app.get(QueueProducer).enqueue(QUEUE.EMAIL, SEND_VERIFICATION_EMAIL_JOB, { userId: user.id }));
    await drainQueue(queue());

    const mail = await receivedBy(user.email);
    expect(mail.Subject).toBe('Confirm your email for NexLegTiq');
    expect(mail.HTML).toContain('dir="ltr"');
    expect(mail.Text).toMatch(/https:\/\/app\.example\.test\/verify-email\?token=[A-Za-z0-9_-]{43}/);
    // unscoped: test assertion.
    const stored = await app.get(PrismaService).unscoped().emailVerificationToken.findFirstOrThrow({ where: { userId: user.id } });
    expect(Math.round((stored.expiresAt.getTime() - before) / 86_400_000)).toBe(7);
  });

  it('should issue a one-hour password-reset link in the worker and send it in Arabic (D-086)', async () => {
    const user = await createUser('AR');
    const before = Date.now();
    await inOffice(() => app.get(QueueProducer).enqueue(QUEUE.EMAIL, SEND_PASSWORD_RESET_JOB, { userId: user.id }));
    await drainQueue(queue());

    const mail = await receivedBy(user.email);
    expect(mail.HTML).toContain('dir="rtl"');
    const link = /https:\/\/app\.example\.test\/reset-password\?token=([A-Za-z0-9_-]{43})/.exec(mail.Text);
    expect(link).not.toBeNull();
    // unscoped: test assertion.
    const stored = await app.get(PrismaService).unscoped().passwordResetToken.findFirstOrThrow({ where: { userId: user.id, usedAt: null } });
    expect(stored.tokenHash).toBe(hashOpaqueToken(link?.[1] ?? ''));
    expect(Math.round((stored.expiresAt.getTime() - before) / 60_000)).toBe(60);
  });

  it('should send nothing for an already verified user', async () => {
    const user = await createUser('EN');
    // unscoped: test setup.
    await app.get(PrismaService).unscoped().user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    const job = await inOffice(() => app.get(QueueProducer).enqueue(QUEUE.EMAIL, SEND_VERIFICATION_EMAIL_JOB, { userId: user.id }));
    await drainQueue(queue());
    expect((await queue().getJob(job.id ?? ''))?.returnvalue).toEqual({ skipped: 'NOTHING_TO_SEND' });
  });

  it('should render and deliver a template email in English, left to right', async () => {
    const to = `invite-${randomUUID()}@example.test`;
    await inOffice(() =>
      app.get(MailService).send(to, 'invite', 'EN', { officeName: 'Al-Masri & Partners', inviterName: 'Omar', link: 'https://app.example.test/accept', days: 7 }),
    );
    await drainQueue(queue());

    const mail = await receivedBy(to);
    // The office name sits between isolate marks so it keeps its direction inside any sentence.
    expect(mail.Subject).toBe('Invitation to join ⁨Al-Masri & Partners⁩ on NexLegTiq');
    expect(mail.HTML).toContain('dir="ltr"');
    expect(mail.HTML).toContain('Al-Masri &amp; Partners');
    expect(mail.HTML).toContain('https://app.example.test/legal/privacy');
  });
});
