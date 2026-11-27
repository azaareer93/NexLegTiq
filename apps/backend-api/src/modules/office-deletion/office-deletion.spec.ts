import { OfficeDeletionMailer } from './office-deletion.mailer';
import { deletionOf, OfficeDeletionService } from './office-deletion.service';
import { OfficePurge } from './office-purge';
import { totpCode, totpStep } from '../platform-auth/totp';

const OFFICE = '01920000-0000-7000-8000-000000000001';
const USER = '01920000-0000-7000-8000-000000000002';
const SECRET = 'JBSWY3DPEHPK3PXP';
const client = { ip: '127.0.0.1', userAgent: null, requestId: null };
const later = new Date(Date.now() + 10 * 86_400_000);

function build(
  user: Partial<{ mfaEnabled: boolean }> = {},
  updated = 1,
  scheduled: Date | null = later,
) {
  const tx = {
    office: { updateMany: jest.fn().mockResolvedValue({ count: updated }), update: jest.fn() },
    auditLog: { create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ scheduled, purged: null }]),
  };
  const prisma = {
    db: {
      office: {
        findFirstOrThrow: jest
          .fn()
          .mockResolvedValue({ deletionRequestedAt: null, deletionScheduledFor: null }),
      },
      user: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          id: USER,
          passwordHash: 'hash',
          mfaEnabled: user.mfaEnabled ?? false,
          mfaSecret: 'cipher',
        }),
      },
    },
    unscoped: () => ({ $transaction: (work: (t: typeof tx) => unknown) => work(tx) }),
  };
  const uow = { run: (work: (t: typeof tx) => unknown) => work(tx) };
  const cls = { get: (key: string) => ({ officeId: OFFICE, userId: USER })[key] };
  const passwords = {
    verify: jest.fn(async (_hash: string, password: string) => password === 'right'),
  };
  const cipher = { decrypt: jest.fn().mockReturnValue(SECRET) };
  const entitlements = { invalidate: jest.fn() };
  const audit = { log: jest.fn() };
  const mailer = { notify: jest.fn() };
  const service = new OfficeDeletionService(
    prisma as never,
    uow as never,
    cls as never,
    passwords as never,
    cipher as never,
    entitlements as never,
    audit as never,
    mailer as never,
  );
  return { service, tx, prisma, entitlements, audit, mailer, cipher };
}

describe('OfficeDeletionService', () => {
  it('should schedule the purge 30 days ahead after the password, audit it and tell the managers', async () => {
    const { service, tx, entitlements, mailer } = build();
    await service.request({ password: 'right' }, client);
    const { data } = tx.office.updateMany.mock.calls[0][0] as {
      data: { deletionScheduledFor: Date; deletionRequestedAt: Date };
    };
    expect(data.deletionScheduledFor.getTime() - data.deletionRequestedAt.getTime()).toBe(
      30 * 86_400_000,
    );
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'SECURITY',
      entityType: 'Office',
      newValues: { deletion: 'REQUESTED' },
    });
    expect(entitlements.invalidate).toHaveBeenCalledWith(OFFICE);
    expect(mailer.notify).toHaveBeenCalledWith(OFFICE, 'requested', data.deletionScheduledFor);
  });

  it('should refuse a wrong password, a missing or wrong MFA code, and a second request', async () => {
    await expect(build().service.request({ password: 'wrong' }, client)).rejects.toMatchObject({
      code: 'VAL-001',
      details: [{ field: 'password', message: 'validation.password.currentWrong' }],
    });
    const mfa = build({ mfaEnabled: true });
    await expect(mfa.service.request({ password: 'right' }, client)).rejects.toMatchObject({
      details: [{ field: 'mfaCode', message: 'validation.required' }],
    });
    await expect(
      mfa.service.request({ password: 'right', mfaCode: '000000' }, client),
    ).rejects.toMatchObject({ details: [{ field: 'mfaCode', message: 'validation.totpWrong' }] });
    const code = totpCode(SECRET, totpStep(new Date()));
    await expect(
      mfa.service.request({ password: 'right', mfaCode: code }, client),
    ).resolves.toEqual({
      requestedAt: null,
      scheduledFor: null,
    });
    expect(mfa.cipher.decrypt).toHaveBeenCalledWith('cipher', `users.mfa_secret:${USER}`);
    await expect(build({}, 0).service.request({ password: 'right' }, client)).rejects.toMatchObject(
      {
        code: 'RES-003',
      },
    );
  });

  it('should cancel a scheduled deletion and refuse when none is', async () => {
    const { service, mailer } = build();
    await service.cancel(client);
    expect(mailer.notify).toHaveBeenCalledWith(OFFICE, 'cancelled', null);
    await expect(build({}, 0).service.cancel(client)).rejects.toMatchObject({ code: 'RES-003' });
  });

  it('should let platform staff cancel, or bring the date forward but never back or into the past', async () => {
    const { service, audit, tx, mailer } = build();
    await service.adminCancel(OFFICE, 'Office asked by phone', 'admin', client);
    expect(audit.log.mock.calls[0][0]).toMatchObject({
      action: 'OFFICE_DELETION_CANCELLED',
      newValues: { reason: 'Office asked by phone' },
    });
    const sooner = new Date(Date.now() + 86_400_000);
    await service.adminReschedule(OFFICE, sooner, 'Letter ref 12', 'admin', client);
    expect(tx.office.update).toHaveBeenLastCalledWith({
      where: { id: OFFICE },
      data: { deletionScheduledFor: sooner },
    });
    expect(mailer.notify).toHaveBeenLastCalledWith(OFFICE, 'rescheduled', sooner);
    for (const when of [new Date(later.getTime() + 1000), new Date(Date.now() - 60_000)]) {
      await expect(
        service.adminReschedule(OFFICE, when, 'x', 'admin', client),
      ).rejects.toMatchObject({
        details: [{ field: 'scheduledFor', message: 'validation.deletionDate' }],
      });
    }
    await expect(
      build({}, 1, null).service.adminCancel(OFFICE, 'r', 'a', client),
    ).rejects.toMatchObject({
      code: 'RES-003',
    });
    const missing = build();
    missing.tx.$queryRaw.mockResolvedValue([]);
    await expect(missing.service.adminCancel(OFFICE, 'r', 'a', client)).rejects.toMatchObject({
      code: 'RES-001',
    });
  });

  it('should present the admin state only when a deletion is scheduled or done', () => {
    const none = { deletionRequestedAt: null, deletionScheduledFor: null, purgedAt: null };
    expect(deletionOf(none)).toBeNull();
    expect(deletionOf({ ...none, purgedAt: new Date('2026-12-01T00:00:00Z') })).toEqual({
      requestedAt: null,
      scheduledFor: null,
      purgedAt: '2026-12-01T00:00:00.000Z',
    });
  });
});

describe('OfficeDeletionMailer', () => {
  const logger = { setContext: jest.fn(), warn: jest.fn() };
  const config = { mail: { officeAppUrl: 'https://app.example.test' } };

  it('should email every active office manager in their language with the office-local date', async () => {
    const raw = {
      office: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ name: 'Office', timezone: 'Asia/Hebron' }),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          { email: 'a@example.test', fullName: 'A', uiLanguage: 'AR' },
          { email: 'b@example.test', fullName: 'B', uiLanguage: 'EN' },
        ]),
      },
    };
    const mail = { send: jest.fn() };
    const mailer = new OfficeDeletionMailer(
      { unscoped: () => raw } as never,
      mail as never,
      config as never,
      logger as never,
    );
    await mailer.notify(OFFICE, 'requested', new Date('2026-12-27T22:30:00Z'));
    expect(mail.send).toHaveBeenCalledTimes(2);
    expect(mail.send).toHaveBeenCalledWith('b@example.test', 'office-deletion-requested', 'EN', {
      name: 'B',
      officeName: 'Office',
      link: 'https://app.example.test/settings',
      date: '2026-12-28',
    });
  });

  it('should only log when the email cannot be queued', async () => {
    const mailer = new OfficeDeletionMailer(
      {
        unscoped: () => ({
          office: { findUniqueOrThrow: jest.fn().mockRejectedValue(new Error('db')) },
          user: { findMany: jest.fn() },
        }),
      } as never,
      { send: jest.fn() } as never,
      config as never,
      logger as never,
    );
    await expect(mailer.notify(OFFICE, 'cancelled', null)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('OfficePurge', () => {
  it('should purge each due office, go on after one fails, and drop retained invoices past retention', async () => {
    const raw = {
      office: { findMany: jest.fn().mockResolvedValue([{ id: 'o1' }, { id: 'o2' }]) },
      retainedInvoice: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
    };
    const logger = { setContext: jest.fn(), info: jest.fn(), error: jest.fn() };
    const purge = new OfficePurge(
      { unscoped: () => raw } as never,
      {} as never,
      {} as never,
      { retainedRecordsYears: 7 } as never,
      logger as never,
    );
    jest
      .spyOn(purge, 'purge')
      .mockRejectedValueOnce(new Error('storage down'))
      .mockResolvedValueOnce(true);
    await expect(purge.run()).resolves.toEqual({ purged: 1, expired: 3 });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
