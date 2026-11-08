import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { NotificationService } from './notification.service';
import { NotificationsService } from './notifications.service';
import type { RequestContext } from '../../common/context/request-context';
import type { QueueProducer } from '../../common/queue/queue-producer';
import type { PrismaService } from '../../database/prisma.service';

const ID = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, readAt: Date | null = null) => ({
  id: ID(n),
  type: 'TASK_ASSIGNED',
  titleKey: 'common.notifications.taskAssigned',
  params: { title: 'Draft' },
  link: null,
  readAt,
  createdAt: new Date('2026-11-08T10:00:00.000Z'),
});

function setup(rows: ReturnType<typeof row>[] = [], userId: string | null = 'u1') {
  const notification = {
    findMany: jest.fn().mockResolvedValue(rows),
    findFirst: jest.fn().mockResolvedValue(rows[0] ?? null),
    count: jest.fn().mockResolvedValue(3),
    updateMany: jest.fn().mockResolvedValue({ count: 2 }),
  };
  const service = new NotificationsService(
    { db: { notification } } as unknown as PrismaService,
    { get: () => userId ?? undefined } as unknown as ClsService<RequestContext>,
    { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger,
  );
  return { service, notification };
}

describe('NotificationsService (D-149)', () => {
  it('should page by id with one extra row to know whether a next page exists', async () => {
    const { service, notification } = setup([row(3), row(2), row(1)]);
    await expect(service.list({ limit: 2, unread: true, cursor: ID(9) })).resolves.toMatchObject({
      items: [{ id: ID(3) }, { id: ID(2) }],
      nextCursor: ID(2),
    });
    expect(notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', readAt: null, id: { lt: ID(9) } },
        orderBy: { id: 'desc' },
        take: 3,
      }),
    );
    const last = setup([row(1, new Date('2026-11-08T11:00:00.000Z'))]);
    await expect(last.service.list({ limit: 2 })).resolves.toMatchObject({
      items: [{ readAt: '2026-11-08T11:00:00.000Z' }],
      nextCursor: null,
    });
    expect(last.notification.findMany.mock.calls[0]?.[0].where).toEqual({ userId: 'u1' });
  });

  it('should count, mark one and mark all read for the caller only', async () => {
    const { service, notification } = setup([row(1)]);
    await expect(service.unreadCount()).resolves.toEqual({ count: 3 });
    await expect(service.markRead(ID(1))).resolves.toMatchObject({ id: ID(1) });
    expect(notification.updateMany).toHaveBeenCalledWith({
      where: { id: ID(1), userId: 'u1', readAt: null },
      data: { readAt: expect.any(Date) },
    });
    await expect(service.markAllRead()).resolves.toEqual({ count: 2 });
    await expect(setup([]).service.markRead(ID(1))).rejects.toMatchObject({ code: 'RES-001' });
    await expect(setup([], null).service.unreadCount()).rejects.toThrow('No caller');
  });
});

describe('NotificationService.notify (D-149)', () => {
  it('should queue one fan-out job for the distinct recipients, and none for nobody', async () => {
    const queues = { enqueue: jest.fn() };
    const service = new NotificationService(queues as unknown as QueueProducer);
    const content = {
      type: 'DOCUMENT_PROCESSED' as const,
      titleKey: 'shell.notifications.documentProcessed',
      params: { name: 'a.pdf' },
      link: null,
    };
    await service.notify(['u1', 'u1', 'u2'], content, { jobId: 'j1' });
    expect(queues.enqueue).toHaveBeenCalledWith(
      'notification',
      'fan-out-notification',
      { ...content, userIds: ['u1', 'u2'] },
      { jobId: 'j1' },
    );
    await service.notify([], content);
    expect(queues.enqueue).toHaveBeenCalledTimes(1);
  });
});
