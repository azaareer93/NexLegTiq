import type { PinoLogger } from 'nestjs-pino';

import {
  AccountMailer,
  SEND_PASSWORD_RESET_JOB,
  SEND_VERIFICATION_EMAIL_JOB,
} from './account-mailer';
import type { QueueProducer } from '../../common/queue/queue-producer';
import type { TenantRunner } from '../../common/tenancy/tenant-runner';

const USER = {
  userId: '01920000-0000-7000-8000-0000000000a1',
  officeId: '01920000-0000-7000-8000-0000000000b1',
};
const CLIENT = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };

describe('AccountMailer (D-085, D-086)', () => {
  function setup(fails = false) {
    const enqueue = fails ? jest.fn().mockRejectedValue(new Error('redis down')) : jest.fn();
    const logger = { setContext: jest.fn(), error: jest.fn() };
    const mailer = new AccountMailer(
      { run: (_ctx: unknown, work: () => unknown) => work() } as unknown as TenantRunner,
      { enqueue } as unknown as QueueProducer,
      logger as unknown as PinoLogger,
    );
    return { mailer, enqueue, logger };
  }

  it('should queue the job with the user id only', async () => {
    const { mailer, enqueue } = setup();
    await mailer.sendVerification(USER as never, CLIENT);
    await mailer.sendPasswordReset(USER as never, CLIENT);
    expect(enqueue.mock.calls.map((c) => c[1])).toEqual([
      SEND_VERIFICATION_EMAIL_JOB,
      SEND_PASSWORD_RESET_JOB,
    ]);
    expect(enqueue.mock.calls[0][2]).toEqual({ userId: USER.userId });
  });

  it('should log, never throw, when the queue refuses', async () => {
    const { mailer, logger } = setup(true);
    await expect(mailer.sendVerification(USER as never, CLIENT)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER.userId, job: SEND_VERIFICATION_EMAIL_JOB }),
      'Could not enqueue an account email',
    );
  });
});
