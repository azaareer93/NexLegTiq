import type { ModuleRef } from '@nestjs/core';
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
const OTHER = '01920000-0000-7000-8000-0000000000bb';
const FIELDS = {
  userIds: [USER, OTHER],
  type: 'HEARING_REMINDER',
  titleKey: 'shell.notifications.hearingReminder',
  params: { fileNumber: '2026-LIT-00001', daysBefore: 1 },
  link: '/calendar?session=1',
};

function setup(prefs: Record<string, unknown> = {}) {
  const createManyAndReturn = jest.fn(({ data }: { data: { userId: string }[] }) =>
    Promise.resolve(data.map(({ userId }, i) => ({ id: `n${i}`, userId }))),
  );
  const deleteMany = jest.fn().mockResolvedValue({ count: 4 });
  const prisma = {
    db: {
      office: { findFirst: jest.fn().mockResolvedValue({ isActive: true }) },
      notification: { createManyAndReturn },
      user: {
        findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(where.id.in.map((id) => ({ id, notificationPrefs: prefs[id] ?? {} }))),
        ),
      },
    },
    unscoped: () => ({ notification: { deleteMany } }),
  } as unknown as PrismaService;
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() } as unknown as PinoLogger;
  const realtime = { toUser: jest.fn(), toUsers: jest.fn(), toOffice: jest.fn() };
  const processor = new NotificationProcessor(
    new TenantRunner(ClsServiceManager.getClsService<RequestContext>()),
    prisma,
    logger,
    realtime as unknown as RealtimePublisher,
    {} as ModuleRef,
  );
  const job = (name: string, data: object, office: string | null = OFFICE) =>
    ({
      id: '1',
      name,
      queueName: 'notification',
      attemptsMade: 0,
      data: office ? { officeId: office, requestId: null, ...data } : data,
    }) as unknown as Job<never>;
  return { processor, createManyAndReturn, deleteMany, realtime, job };
}

describe('NotificationProcessor (D-149)', () => {
  it('should write one row per recipient in the job office and push each', async () => {
    const { processor, createManyAndReturn, realtime, job } = setup();
    await expect(processor.process(job('fan-out-notification', FIELDS))).resolves.toEqual({
      created: 2,
    });
    const { userIds, ...content } = FIELDS;
    expect(createManyAndReturn).toHaveBeenCalledWith({
      data: userIds.map((userId) => ({ officeId: OFFICE, userId, ...content, channel: 'IN_APP' })),
      select: { id: true, userId: true },
    });
    expect(realtime.toUser).toHaveBeenCalledWith(OTHER, 'notification', { notificationId: 'n1' });
  });

  it('should leave out recipients who turned the category off in the app (D-146)', async () => {
    const { processor, createManyAndReturn, job } = setup({
      [USER]: { HEARINGS: { inApp: false } },
    });
    await expect(processor.process(job('fan-out-notification', FIELDS))).resolves.toEqual({
      created: 1,
    });
    const muted = setup({
      [USER]: { HEARINGS: { inApp: false } },
      [OTHER]: { HEARINGS: { inApp: false } },
    });
    await expect(
      muted.processor.process(muted.job('fan-out-notification', FIELDS)),
    ).resolves.toEqual({ created: 0 });
    expect(muted.createManyAndReturn).not.toHaveBeenCalled();
    expect(createManyAndReturn.mock.calls[0]?.[0].data).toHaveLength(1);
  });

  it('should purge rows older than 90 days only as the scheduled platform job', async () => {
    const { processor, deleteMany, job } = setup();
    await expect(processor.process(job('purge-notifications', {}, null))).resolves.toEqual({
      removed: 4,
    });
    const cutoff = (deleteMany.mock.calls[0]?.[0] as { where: { createdAt: { lt: Date } } }).where
      .createdAt.lt;
    expect(Date.now() - cutoff.getTime()).toBeCloseTo(90 * 86_400_000, -4);
    // A tenant job cannot start the cross-office purge.
    await expect(processor.process(job('purge-notifications', FIELDS))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unknown job', 'other', FIELDS],
    ['an external link', 'fan-out-notification', { ...FIELDS, link: '//evil.test' }],
    ['text instead of an i18n key', 'fan-out-notification', { ...FIELDS, titleKey: 'Hello there' }],
    ['an unknown type', 'fan-out-notification', { ...FIELDS, type: 'task.assigned' }],
    ['no recipient', 'fan-out-notification', { ...FIELDS, userIds: [] }],
  ])('should refuse %s without retries', async (_case, name, fields) => {
    const { processor, createManyAndReturn, job } = setup();
    await expect(processor.process(job(name, fields))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(createManyAndReturn).not.toHaveBeenCalled();
  });
});
