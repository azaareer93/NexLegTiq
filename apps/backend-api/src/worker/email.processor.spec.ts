import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import type { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import type { MailTransport } from '../common/mail/mail-transport';
import { TenantRunner } from '../common/tenancy/tenant-runner';
import { AppConfig } from '../config/app-config';
import { testEnv } from '../config/env.fixture';
import { parseEnv } from '../config/env.schema';
import type { PrismaService } from '../database/prisma.service';
import type { PasswordResetLinks } from '../modules/auth/password-reset-links';
import type { VerificationLinks } from '../modules/auth/verification-links';
import { EmailProcessor, SKIPPED_NOTHING_TO_SEND } from './email.processor';

const OFFICE = '01920000-0000-7000-8000-00000000000a';
const USER = '01920000-0000-7000-8000-0000000000aa';
const APP = 'https://app.test';

function setup(
  issued: object | null = {
    to: 'a@b.test',
    locale: 'AR',
    vars: { name: 'عمر', link: `${APP}/verify-email?token=t`, days: 7 },
  },
) {
  const send = jest.fn().mockResolvedValue(undefined);
  const issue = jest.fn().mockResolvedValue(issued);
  const issueReset = jest.fn().mockResolvedValue({
    to: 'r@b.test',
    locale: 'EN',
    vars: { name: 'Omar', link: `${APP}/reset-password?token=t`, minutes: 60 },
  });
  const prisma = {
    db: { office: { findFirst: jest.fn().mockResolvedValue({ isActive: true }) } },
  } as unknown as PrismaService;
  const logger = {
    setContext: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;
  const config = new AppConfig(
    parseEnv(testEnv({ NODE_ENV: 'development', OFFICE_APP_URL: `${APP}/` })),
  );
  const processor = new EmailProcessor(
    new TenantRunner(ClsServiceManager.getClsService<RequestContext>()),
    prisma,
    logger,
    { send } as unknown as MailTransport,
    { issue } as unknown as VerificationLinks,
    { issue: issueReset } as unknown as PasswordResetLinks,
    config,
  );
  const job = (name: string, data: object, attemptsMade = 0) =>
    ({
      id: '7',
      name,
      queueName: 'email',
      attemptsMade,
      data: { officeId: OFFICE, requestId: null, ...data },
    }) as Job<never>;
  return { processor, send, issue, issueReset, job };
}

const reset = {
  to: 'c@d.test',
  template: 'password-reset',
  locale: 'EN',
  vars: { name: 'Omar', link: `${APP}/reset`, minutes: 60 },
};

describe('EmailProcessor', () => {
  it('should issue a verification link in the worker and send it in the user language, one message per attempt', async () => {
    const { processor, send, issue, job } = setup();
    await expect(
      processor.process(job('send-verification-email', { userId: USER }, 1)),
    ).resolves.toEqual({ sent: 'verify-email' });
    expect(issue).toHaveBeenCalledWith(USER, expect.any(Date), { retry: true });
    const [to, mail, options] = send.mock.calls[0] ?? [];
    expect(to).toBe('a@b.test');
    expect(mail.html).toContain('dir="rtl"');
    expect(options).toEqual({ signal: expect.any(AbortSignal), idempotencyKey: '7-1' });
  });

  it('should issue a password-reset link in the worker and email it, one message per attempt', async () => {
    const { processor, send, issueReset, job } = setup();
    await expect(processor.process(job('send-password-reset', { userId: USER }))).resolves.toEqual({
      sent: 'password-reset',
    });
    expect(issueReset).toHaveBeenCalledWith(USER, expect.any(Date), { retry: false });
    const [to, mail, options] = send.mock.calls[0] ?? [];
    expect(to).toBe('r@b.test');
    expect(mail.subject).toBe('Reset your NexLegTiq password');
    expect(mail.text).toContain('60 minutes');
    expect(options).toEqual({ signal: expect.any(AbortSignal), idempotencyKey: '7-0' });

    await processor.process(job('send-password-reset', { userId: USER }, 2));
    expect(issueReset).toHaveBeenLastCalledWith(USER, expect.any(Date), { retry: true });
    expect(send.mock.calls[1]?.[2]).toEqual({
      signal: expect.any(AbortSignal),
      idempotencyKey: '7-2',
    });

    issueReset.mockResolvedValueOnce(null);
    await expect(processor.process(job('send-password-reset', { userId: USER }))).resolves.toEqual(
      SKIPPED_NOTHING_TO_SEND,
    );
  });

  it('should send nothing when there is no link to send (verified, deactivated, or rate-limited)', async () => {
    const { processor, send, job } = setup(null);
    await expect(
      processor.process(job('send-verification-email', { userId: USER })),
    ).resolves.toEqual(SKIPPED_NOTHING_TO_SEND);
    expect(send).not.toHaveBeenCalled();
  });

  it('should render and send a template email with the job id as idempotency key', async () => {
    const { processor, send, job } = setup();
    await expect(processor.process(job('send-email', reset))).resolves.toEqual({
      sent: 'password-reset',
    });
    expect(send).toHaveBeenCalledWith(
      'c@d.test',
      expect.objectContaining({ subject: 'Reset your NexLegTiq password' }),
      {
        signal: expect.any(AbortSignal),
        idempotencyKey: '7',
      },
    );
  });

  it('should rethrow a delivery failure as EXT-001 so BullMQ retries it', async () => {
    const { processor, send, job } = setup();
    send.mockRejectedValue(new AppException('EXT-001', 'Email provider failed'));
    const error = await processor
      .process(job('send-email', reset))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'EXT-001' });
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });

  it.each([
    [
      'an unknown template',
      'send-email',
      { to: 'c@d.test', template: 'newsletter', locale: 'EN', vars: {} },
    ],
    ['missing template variables', 'send-email', { ...reset, vars: { name: 'Omar' } }],
    ['a bad recipient', 'send-email', { ...reset, to: 'not-an-email' }],
    ['a verification job without a user', 'send-verification-email', {}],
  ])('should fail without retries for %s', async (_label, name, data) => {
    const { processor, send, job } = setup();
    await expect(processor.process(job(name, data))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a link outside the office app',
      'send-email',
      { ...reset, vars: { ...reset.vars, link: 'https://evil.test/reset' } },
    ],
    ['a job name it does not know', 'send-fax', { userId: USER }],
  ])('should fail without retries for %s', async (_label, name, data) => {
    const { processor, send, job } = setup();
    await expect(processor.process(job(name, data))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(send).not.toHaveBeenCalled();
  });
});
