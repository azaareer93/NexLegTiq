import type { Job } from 'bullmq';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import type { RequestContext } from '../common/context/request-context';
import type { MailTransport } from '../common/mail/mail-transport';
import { TenantRunner } from '../common/tenancy/tenant-runner';
import { AppConfig } from '../config/app-config';
import { testEnv } from '../config/env.fixture';
import { parseEnv } from '../config/env.schema';
import type { PrismaService } from '../database/prisma.service';
import type { VerificationLinks } from '../modules/auth/verification-links';
import { EmailProcessor, SKIPPED_NOTHING_TO_SEND } from './email.processor';

const OFFICE = '01920000-0000-7000-8000-00000000000a';
const USER = '01920000-0000-7000-8000-0000000000aa';

function setup(issued: object | null = { to: 'a@b.test', locale: 'AR', vars: { name: 'عمر', link: 'https://app.test/verify-email?token=t', days: 7 } }) {
  const send = jest.fn().mockResolvedValue(undefined);
  const issue = jest.fn().mockResolvedValue(issued);
  const prisma = { db: { office: { findFirst: jest.fn().mockResolvedValue({ isActive: true }) } } } as unknown as PrismaService;
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as PinoLogger;
  const config = new AppConfig(parseEnv(testEnv({ NODE_ENV: 'development', OFFICE_APP_URL: 'https://app.test/' })));
  const processor = new EmailProcessor(
    new TenantRunner(ClsServiceManager.getClsService<RequestContext>()),
    prisma,
    logger,
    { send } as unknown as MailTransport,
    { issue } as unknown as VerificationLinks,
    config,
  );
  const job = (name: string, data: object) =>
    ({ id: '1', name, queueName: 'email', attemptsMade: 0, data: { officeId: OFFICE, requestId: null, ...data } }) as Job<never>;
  return { processor, send, issue, job };
}

describe('EmailProcessor', () => {
  it('should issue a verification link in the worker and send it in the user language', async () => {
    const { processor, send, issue, job } = setup();
    await expect(processor.process(job('send-verification-email', { userId: USER }))).resolves.toEqual({ sent: 'verify-email' });
    expect(issue).toHaveBeenCalledWith(USER, expect.any(Date));
    const [to, mail] = send.mock.calls[0] ?? [];
    expect(to).toBe('a@b.test');
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.html).toContain('https://app.test/legal/terms');
  });

  it('should send nothing when there is no link to send (verified or deactivated user)', async () => {
    const { processor, send, job } = setup(null);
    await expect(processor.process(job('send-verification-email', { userId: USER }))).resolves.toEqual(SKIPPED_NOTHING_TO_SEND);
    expect(send).not.toHaveBeenCalled();
  });

  it('should render and send a template email', async () => {
    const { processor, send, job } = setup();
    const vars = { name: 'Omar', link: 'https://app.test/reset', minutes: 60 };
    await expect(processor.process(job('send-email', { to: 'c@d.test', template: 'password-reset', locale: 'EN', vars }))).resolves.toEqual({
      sent: 'password-reset',
    });
    expect(send).toHaveBeenCalledWith('c@d.test', expect.objectContaining({ subject: 'Reset your NexLegTiq password' }), expect.any(AbortSignal));
  });

  it.each([
    ['an unknown template', 'send-email', { to: 'c@d.test', template: 'newsletter', locale: 'EN', vars: {} }],
    ['a bad recipient', 'send-email', { to: 'not-an-email', template: 'invite', locale: 'EN', vars: {} }],
    ['a verification job without a user', 'send-verification-email', {}],
  ])('should fail without retries for %s', async (_label, name, data) => {
    const { processor, send, job } = setup();
    await expect(processor.process(job(name, data))).rejects.toMatchObject({ name: 'UnrecoverableError' });
    expect(send).not.toHaveBeenCalled();
  });

  it('should fail a job name it does not know', async () => {
    const { processor, job } = setup();
    await expect(processor.process(job('send-fax', { userId: USER }))).rejects.toThrow('Unknown email job send-fax');
  });
});
