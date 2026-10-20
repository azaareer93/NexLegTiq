import { ReminderDelivery } from './reminder-delivery';
import type { MailService } from '../../common/mail/mail.service';
import type { QueueProducer } from '../../common/queue/queue-producer';
import type { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';

const APP = 'https://app.test';
const NOW = new Date('2026-11-05T07:00:00Z');
const STARTS = new Date('2026-11-12T08:30:00Z'); // 10:30 in Hebron

const row = (overrides: Record<string, unknown> = {}, session: Record<string, unknown> = {}) => ({
  id: 'rem1',
  status: 'PENDING',
  daysBefore: 7,
  recipient: {
    id: 'u1',
    fullName: 'عمر',
    email: 'omar@office.test',
    isActive: true,
    uiLanguage: 'AR',
    timezone: null,
  },
  session: {
    id: 's1',
    startsAt: STARTS,
    isCancelled: false,
    outcome: null,
    courtRoom: null,
    court: { nameAr: 'محكمة صلح رام الله', nameEn: 'Ramallah Magistrate Court' },
    file: {
      id: 'f1',
      fileNumber: '2026-LIT-00001',
      title: 'دعوى',
      status: 'OPEN',
      deletedAt: null,
    },
    ...session,
  },
  ...overrides,
});

function setup(found: unknown = row()) {
  const db = {
    sessionReminder: {
      findFirst: jest.fn().mockResolvedValue(found),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    office: { findFirstOrThrow: jest.fn().mockResolvedValue({ timezone: 'Asia/Hebron' }) },
    // CaseAccessService.colleagueMay: the recipient is active and sees the file.
    user: { findFirst: jest.fn().mockResolvedValue({ id: 'u1', role: 'LAWYER' }) },
    legalFile: { count: jest.fn().mockResolvedValue(1) },
  };
  const mail = { send: jest.fn().mockResolvedValue(undefined) };
  const queues = { enqueue: jest.fn().mockResolvedValue({}) };
  const config = new AppConfig(
    parseEnv(testEnv({ NODE_ENV: 'development', OFFICE_APP_URL: `${APP}/` })),
  );
  const delivery = new ReminderDelivery(
    { db } as unknown as PrismaService,
    mail as unknown as MailService,
    queues as unknown as QueueProducer,
    config,
    { toUser: jest.fn(), toUsers: jest.fn(), toOffice: jest.fn() } as unknown as RealtimePublisher,
  );
  return { delivery, db, mail, queues };
}

describe('ReminderDelivery', () => {
  it('should email in the recipient language and zone, notify in-app, then mark SENT', async () => {
    const { delivery, db, mail, queues } = setup();
    await expect(delivery.deliver('rem1', NOW)).resolves.toEqual({ sent: 'u1' });

    expect(mail.send).toHaveBeenCalledWith(
      'omar@office.test',
      'hearing-reminder',
      'AR',
      {
        name: 'عمر',
        link: `${APP}/calendar?session=s1`,
        fileNumber: '2026-LIT-00001',
        fileTitle: 'دعوى',
        date: '12 نوفمبر 2026',
        time: expect.stringMatching(/^10:30/),
        court: 'محكمة صلح رام الله',
        courtRoom: '',
      },
      { jobId: 'reminder-rem1-email' },
    );
    expect(queues.enqueue).toHaveBeenCalledWith(
      'notification',
      'create-notification',
      {
        userId: 'u1',
        type: 'SESSION_REMINDER',
        titleKey: 'shell.notifications.hearingReminder',
        params: {
          fileNumber: '2026-LIT-00001',
          startsAt: STARTS.toISOString(),
          daysBefore: 7,
          sessionId: 's1',
        },
        link: '/calendar?session=s1',
      },
      { jobId: 'reminder-rem1-notification' },
    );
    expect(db.sessionReminder.updateMany).toHaveBeenCalledWith({
      where: { id: 'rem1', status: 'PENDING' },
      data: { status: 'SENT', sentAt: NOW },
    });
  });

  it('should use English, the English court name and the user zone when set', async () => {
    const { delivery, mail } = setup(
      row({
        recipient: {
          id: 'u1',
          fullName: 'Omar',
          email: 'omar@office.test',
          isActive: true,
          uiLanguage: 'EN',
          timezone: 'UTC',
        },
      }),
    );
    await delivery.deliver('rem1', NOW);
    expect(mail.send).toHaveBeenCalledWith(
      'omar@office.test',
      'hearing-reminder',
      'EN',
      expect.objectContaining({
        date: '12 November 2026',
        time: '8:30 AM',
        court: 'Ramallah Magistrate Court',
      }),
      expect.anything(),
    );
  });

  it('should do nothing for a missing or no longer pending reminder (a second run)', async () => {
    for (const [found, result] of [
      [null, { skipped: 'MISSING' }],
      [row({ status: 'SENT' }), { skipped: 'NOT_PENDING' }],
    ] as const) {
      const { delivery, mail, db } = setup(found);
      await expect(delivery.deliver('rem1', NOW)).resolves.toEqual(result);
      expect(mail.send).not.toHaveBeenCalled();
      expect(db.sessionReminder.updateMany).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['SESSION_CANCELLED', row({}, { isCancelled: true })],
    ['SESSION_HELD', row({}, { outcome: 'ADJOURNED' })],
    ['SESSION_STARTED', row({}, { startsAt: NOW })],
    [
      'FILE_DELETED',
      row({}, { file: { ...row().session.file, deletedAt: new Date('2026-11-01T00:00:00Z') } }),
    ],
    ['FILE_CLOSED', row({}, { file: { ...row().session.file, status: 'ARCHIVED' } })],
    ['RECIPIENT_INACTIVE', row({ recipient: { ...row().recipient, isActive: false } })],
  ])('should cancel instead of sending: %s', async (reason, found) => {
    const { delivery, mail, db } = setup(found);
    await expect(delivery.deliver('rem1', NOW)).resolves.toEqual({ cancelled: reason });
    expect(mail.send).not.toHaveBeenCalled();
    expect(db.sessionReminder.updateMany).toHaveBeenCalledWith({
      where: { id: 'rem1', status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
  });

  it('should cancel, not send, when the recipient can no longer see the file (made confidential)', async () => {
    const { delivery, mail, queues, db } = setup();
    db.legalFile.count.mockResolvedValue(0);
    await expect(delivery.deliver('rem1', NOW)).resolves.toEqual({
      cancelled: 'RECIPIENT_NO_ACCESS',
    });
    expect(mail.send).not.toHaveBeenCalled();
    expect(queues.enqueue).not.toHaveBeenCalled();
    expect(db.sessionReminder.updateMany).toHaveBeenCalledWith({
      where: { id: 'rem1', status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
  });

  it('should leave the row PENDING when a hand-off fails, so the retry sends it', async () => {
    const { delivery, queues, db } = setup();
    queues.enqueue.mockRejectedValue(new Error('redis down'));
    await expect(delivery.deliver('rem1', NOW)).rejects.toThrow('redis down');
    expect(db.sessionReminder.updateMany).not.toHaveBeenCalled();

    await delivery.markFailed('rem1');
    expect(db.sessionReminder.updateMany).toHaveBeenCalledWith({
      where: { id: 'rem1', status: 'PENDING' },
      data: { status: 'FAILED' },
    });
  });
});
