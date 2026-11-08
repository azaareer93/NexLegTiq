import type { ClsService } from 'nestjs-cls';

import { SessionRemindersService } from './session-reminders.service';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';

const SENT = new Date('2026-11-08T07:00:00.000Z');
const ROW = {
  id: 'r1',
  daysBefore: 1,
  scheduledFor: SENT,
  status: 'SENT',
  recipient: { id: 'u1', fullName: 'Layla Haddad' },
  sentAt: SENT,
  acknowledgedAt: null,
};

function setup(row: typeof ROW | null, userId: string | null = 'u1') {
  const sessionReminder = {
    updateMany: jest.fn().mockResolvedValue({ count: row ? 1 : 0 }),
    findFirst: jest.fn().mockResolvedValue(row),
  };
  const service = new SessionRemindersService(
    { get: () => userId ?? undefined } as unknown as ClsService<RequestContext>,
    { db: { sessionReminder } } as unknown as PrismaService,
  );
  return { service, sessionReminder };
}

describe('SessionRemindersService.acknowledge (D-117)', () => {
  it('should mark only a sent, unacknowledged reminder of the caller as seen', async () => {
    const { service, sessionReminder } = setup(ROW);
    await expect(service.acknowledge('r1')).resolves.toMatchObject({
      id: 'r1',
      sentAt: SENT.toISOString(),
      acknowledgedAt: null,
    });
    expect(sessionReminder.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', recipientId: 'u1', status: 'SENT', acknowledgedAt: null },
      data: { acknowledgedAt: expect.any(Date) },
    });
  });

  it('should answer 404 for someone else’s reminder and fail without a caller', async () => {
    await expect(setup(null).service.acknowledge('r1')).rejects.toMatchObject({ code: 'RES-001' });
    await expect(setup(ROW, null).service.acknowledge('r1')).rejects.toThrow('No caller');
  });
});
