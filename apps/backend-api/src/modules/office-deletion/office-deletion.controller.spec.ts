import { OfficeDeletionController } from './office-deletion.controller';
import { OfficeDeletionMailer } from './office-deletion.mailer';

const status = { requestedAt: null, scheduledFor: null };
const req = { ip: '1.2.3.4', get: () => undefined } as never;

function build(clsActive: boolean) {
  const deletion = {
    status: jest.fn().mockResolvedValue(status),
    request: jest.fn().mockResolvedValue(status),
    cancel: jest.fn().mockResolvedValue(status),
  };
  const cls = { isActive: () => clsActive, getId: () => 'req-1' };
  return { c: new OfficeDeletionController(deletion as never, cls as never), deletion };
}

describe('OfficeDeletionController (D-251)', () => {
  it('should pass the request id when the request context is active, and none otherwise', async () => {
    const active = build(true);
    await expect(active.c.status()).resolves.toBe(status);
    await active.c.request({ password: 'x' }, req);
    expect(active.deletion.request).toHaveBeenCalledWith(
      { password: 'x' },
      expect.objectContaining({ ip: '1.2.3.4', requestId: 'req-1' }),
    );
    const idle = build(false);
    await idle.c.cancel(req);
    expect(idle.deletion.cancel).toHaveBeenCalledWith(expect.objectContaining({ requestId: null }));
  });
});

describe('OfficeDeletionMailer without a date', () => {
  it('should send the cancellation with an empty date', async () => {
    const raw = {
      office: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ name: 'Office', timezone: 'Asia/Hebron' }),
      },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ email: 'a@example.test', fullName: 'A', uiLanguage: 'AR' }]),
      },
    };
    const mail = { send: jest.fn() };
    const mailer = new OfficeDeletionMailer(
      { unscoped: () => raw } as never,
      mail as never,
      { mail: { officeAppUrl: 'https://app.example.test' } } as never,
      { setContext: jest.fn(), warn: jest.fn() } as never,
    );
    await mailer.notify('o1', 'cancelled', null);
    expect(mail.send).toHaveBeenCalledWith(
      'a@example.test',
      'office-deletion-cancelled',
      'AR',
      expect.objectContaining({ date: '' }),
    );
  });
});
