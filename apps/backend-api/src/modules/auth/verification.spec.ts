import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { SEND_VERIFICATION_EMAIL_JOB, AccountMailer } from './account-mailer';
import type { ClientInfo } from './client-info';
import { VerificationLinks } from './verification-links';
import { hashOpaqueToken } from '../../common/auth/opaque-token';
import type { RequestContext } from '../../common/context/request-context';
import type { QueueProducer } from '../../common/queue/queue-producer';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { TenantContextMissingError } from '../../common/tenancy/tenant.errors';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';

const OFFICE = '01920000-0000-7000-8000-00000000000a';
const USER = '01920000-0000-7000-8000-0000000000aa';
const cls = ClsServiceManager.getClsService<RequestContext>();
const runner = new TenantRunner(cls);
const client: ClientInfo = { ip: '10.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const logger = () =>
  ({ setContext: jest.fn(), error: jest.fn() }) as unknown as PinoLogger & { error: jest.Mock };

describe('VerificationLinks (worker side, D-085)', () => {
  const now = new Date('2026-10-03T10:00:00Z');

  function setup(
    user: object | null = {
      email: 'a@b.test',
      fullName: 'Omar',
      uiLanguage: 'EN',
      emailVerifiedAt: null,
      isActive: true,
    },
    recentLinks: Date[] = [],
  ) {
    const tx = {
      user: { findFirst: jest.fn().mockResolvedValue(user) },
      emailVerificationToken: {
        findMany: jest.fn().mockResolvedValue(recentLinks.map((createdAt) => ({ createdAt }))),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      db: { $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)) },
    } as unknown as PrismaService;
    const config = new AppConfig(
      parseEnv(testEnv({ NODE_ENV: 'development', OFFICE_APP_URL: 'https://app.test/' })),
    );
    return { links: new VerificationLinks(prisma, cls, config), tx };
  }

  it('should end earlier links, store only the hash of a new 7-day link and return the email to send', async () => {
    const { links, tx } = setup();
    const email = await runner.run({ officeId: OFFICE as never }, () => links.issue(USER, now));

    expect(tx.emailVerificationToken.updateMany).toHaveBeenCalledWith({
      where: { userId: USER, usedAt: null },
      data: { usedAt: now },
    });
    const token = new URL(email?.vars.link ?? 'http://x').searchParams.get('token') ?? '';
    expect(email).toMatchObject({ to: 'a@b.test', locale: 'EN', vars: { name: 'Omar', days: 7 } });
    expect(email?.vars.link.startsWith('https://app.test/verify-email?token=')).toBe(true);
    expect(tx.emailVerificationToken.create).toHaveBeenCalledWith({
      data: {
        officeId: OFFICE,
        userId: USER,
        tokenHash: hashOpaqueToken(token),
        expiresAt: new Date('2026-10-10T10:00:00Z'),
      },
    });
  });

  it.each([
    ['an unknown user', null],
    [
      'a verified user',
      {
        email: 'a@b.test',
        fullName: 'O',
        uiLanguage: 'AR',
        emailVerifiedAt: new Date(),
        isActive: true,
      },
    ],
    [
      'a deactivated user',
      {
        email: 'a@b.test',
        fullName: 'O',
        uiLanguage: 'AR',
        emailVerifiedAt: null,
        isActive: false,
      },
    ],
  ])('should issue nothing for %s', async (_label, user) => {
    const { links, tx } = setup(user);
    await expect(
      runner.run({ officeId: OFFICE as never }, () => links.issue(USER, now)),
    ).resolves.toBeNull();
    expect(tx.emailVerificationToken.create).not.toHaveBeenCalled();
  });

  it('should issue at most one link a minute per user, except for a retry of the same job', async () => {
    const active = {
      email: 'a@b.test',
      fullName: 'O',
      uiLanguage: 'EN',
      emailVerifiedAt: null,
      isActive: true,
    };
    const justNow = [new Date(now.getTime() - 30_000)];
    const blocked = setup(active, justNow);
    await expect(
      runner.run({ officeId: OFFICE as never }, () => blocked.links.issue(USER, now)),
    ).resolves.toBeNull();
    expect(blocked.tx.emailVerificationToken.create).not.toHaveBeenCalled();

    const retry = setup(active, justNow);
    await expect(
      runner.run({ officeId: OFFICE as never }, () =>
        retry.links.issue(USER, now, { retry: true }),
      ),
    ).resolves.not.toBeNull();

    const later = setup(active, [new Date(now.getTime() - 61_000)]);
    await expect(
      runner.run({ officeId: OFFICE as never }, () => later.links.issue(USER, now)),
    ).resolves.not.toBeNull();
  });

  it('should issue at most five links a day per user, retries included', async () => {
    const active = {
      email: 'a@b.test',
      fullName: 'O',
      uiLanguage: 'EN',
      emailVerifiedAt: null,
      isActive: true,
    };
    const five = Array.from(
      { length: 5 },
      (_unused, index) => new Date(now.getTime() - (index + 1) * 3_600_000),
    );
    const { links, tx } = setup(active, five);
    await expect(
      runner.run({ officeId: OFFICE as never }, () => links.issue(USER, now, { retry: true })),
    ).resolves.toBeNull();
    expect(tx.emailVerificationToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER, createdAt: { gt: new Date(now.getTime() - 86_400_000) } },
        take: 5,
      }),
    );
  });

  it('should write Arabic emails for Arabic users and refuse to run outside an office', async () => {
    const { links } = setup({
      email: 'a@b.test',
      fullName: 'عمر',
      uiLanguage: 'AR',
      emailVerifiedAt: null,
      isActive: true,
    });
    await expect(
      runner.run({ officeId: OFFICE as never }, () => links.issue(USER, now)),
    ).resolves.toMatchObject({ locale: 'AR' });
    await expect(links.issue(USER, now)).rejects.toBeInstanceOf(TenantContextMissingError);
  });
});

describe('AccountMailer', () => {
  it("should enqueue only the user id, in the user's office", async () => {
    const enqueue = jest.fn(async () => ({ officeId: cls.get('officeId') }));
    await new AccountMailer(
      runner,
      { enqueue } as unknown as QueueProducer,
      logger(),
    ).sendVerification({ userId: USER, officeId: OFFICE }, client);
    expect(enqueue).toHaveBeenCalledWith('email', SEND_VERIFICATION_EMAIL_JOB, { userId: USER });
    await expect(enqueue.mock.results[0]?.value).resolves.toEqual({ officeId: OFFICE });
  });

  it('should log a failed enqueue instead of failing the caller', async () => {
    const log = logger();
    const enqueue = jest.fn().mockRejectedValue(new Error('redis down'));
    await expect(
      new AccountMailer(runner, { enqueue } as unknown as QueueProducer, log).sendVerification(
        { userId: USER, officeId: OFFICE },
        client,
      ),
    ).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER }),
      'Could not enqueue an account email',
    );
  });
});
