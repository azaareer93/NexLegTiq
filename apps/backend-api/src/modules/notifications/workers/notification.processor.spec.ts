import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { ClsServiceManager } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { NotificationProcessor } from './notification.processor';
import type { RequestContext } from '../../../common/context/request-context';
import type { RealtimePublisher } from '../../../common/realtime/realtime.publisher';
import { TenantRunner } from '../../../common/tenancy/tenant-runner';
import type { PrismaService } from '../../../database/prisma.service';

const OFFICE = '01920000-0000-7000-8000-00000000000a';
const USER = '01920000-0000-7000-8000-0000000000aa';
const FIELDS = {
  userId: USER,
  type: 'SESSION_REMINDER',
  titleKey: 'shell.notifications.hearingReminder',
  params: { fileNumber: '2026-LIT-00001', daysBefore: 1 },
  link: '/calendar?session=1',
};

function setup(prefs: unknown = {}) {
  const create = jest.fn().mockResolvedValue({ id: 'n1' });
  const prisma = {
    db: {
      office: { findFirst: jest.fn().mockResolvedValue({ isActive: true }) },
      notification: { create },
      user: { findUnique: jest.fn().mockResolvedValue({ notificationPrefs: prefs }) },
    },
  } as unknown as PrismaService;
  const logger = { warn: jest.fn(), error: jest.fn() } as unknown as PinoLogger;
  const processor = new NotificationProcessor(
    new TenantRunner(ClsServiceManager.getClsService<RequestContext>()),
    prisma,
    logger,
    { toUser: jest.fn(), toUsers: jest.fn(), toOffice: jest.fn() } as unknown as RealtimePublisher,
  );
  const job = (name: string, data: object) =>
    ({
      id: '1',
      name,
      queueName: 'notification',
      attemptsMade: 0,
      data: { officeId: OFFICE, requestId: null, ...data },
    }) as unknown as Job<never>;
  return { processor, create, job };
}

describe('NotificationProcessor', () => {
  it('should write an in-app notification for the user in the job office', async () => {
    const { processor, create, job } = setup();
    await expect(processor.process(job('create-notification', FIELDS))).resolves.toEqual({
      notificationId: 'n1',
    });
    expect(create).toHaveBeenCalledWith({
      data: { officeId: OFFICE, ...FIELDS, channel: 'IN_APP' },
      select: { id: true },
    });
  });

  it('should write nothing when the recipient turned the category off in the app (D-146)', async () => {
    const { processor, create, job } = setup({ HEARINGS: { inApp: false } });
    await expect(processor.process(job('create-notification', FIELDS))).resolves.toEqual({
      skipped: 'preferences',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown job', 'other', FIELDS],
    ['an external link', 'create-notification', { ...FIELDS, link: '//evil.test' }],
    ['text instead of an i18n key', 'create-notification', { ...FIELDS, titleKey: 'Hello there' }],
  ])('should refuse %s without retries', async (_case, name, fields) => {
    const { processor, create, job } = setup();
    await expect(processor.process(job(name, fields))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(create).not.toHaveBeenCalled();
  });
});
