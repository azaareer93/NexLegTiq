import type { PinoLogger } from 'nestjs-pino';

import { PortalSessions } from './portal-sessions';
import type { PrismaService } from '../../database/prisma.service';

const NOW = new Date('2026-11-09T10:00:00Z');
const DAY = 86_400_000;
const later = (ms: number) => new Date(NOW.getTime() + ms);

function setup(found: Record<string, unknown> | null, claimed = 1) {
  const table = {
    findUnique: jest.fn().mockResolvedValue(found),
    findFirst: jest.fn().mockResolvedValue(found),
    updateMany: jest.fn().mockResolvedValueOnce({ count: claimed }).mockResolvedValue({ count: 2 }),
    update: jest.fn(),
    create: jest.fn().mockResolvedValue({ id: 'next' }),
  };
  const raw = { clientSession: table, $queryRaw: jest.fn(), $transaction: jest.fn() };
  raw.$transaction.mockImplementation((work: (tx: unknown) => unknown) => work(raw));
  const logger = { setContext: jest.fn(), warn: jest.fn() };
  return {
    sessions: new PortalSessions(
      { unscoped: () => raw } as unknown as PrismaService,
      logger as unknown as PinoLogger,
    ),
    table,
    logger,
  };
}

const live = {
  id: 's1',
  clientUserId: 'c1',
  familyId: 'f1',
  startedAt: NOW,
  expiresAt: later(DAY),
  revokedAt: null,
};

describe('PortalSessions (D-158)', () => {
  it('should start a session whose token lasts 7 days', async () => {
    const { sessions, table } = setup(null);
    const issued = await sessions.start({ clientSession: table } as never, 'c1', NOW);
    expect(issued.expiresAt).toEqual(later(7 * DAY));
    expect(table.create).toHaveBeenCalledTimes(1);
  });

  it('should cap a rotated token at 30 days from the sign-in', async () => {
    const started = later(-29 * DAY);
    const { sessions } = setup({ ...live, startedAt: started, expiresAt: later(DAY) });
    const rotated = await sessions.rotate('t', NOW);
    expect(rotated.expiresAt).toEqual(later(DAY));
    expect(rotated.clientUserId).toBe('c1');
  });

  it('should refuse unknown, reused, raced, expired and over-age tokens', async () => {
    await expect(setup(null).sessions.rotate('t', NOW)).rejects.toMatchObject({ code: 'AUTH-005' });
    const reused = setup({ ...live, revokedAt: NOW });
    await expect(reused.sessions.rotate('t', NOW)).rejects.toMatchObject({ code: 'AUTH-005' });
    expect(reused.logger.warn).toHaveBeenCalled();
    expect(reused.table.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { familyId: 'f1', revokedAt: null } }),
    );
    await expect(setup(live, 0).sessions.rotate('t', NOW)).rejects.toMatchObject({
      code: 'AUTH-005',
    });
    await expect(
      setup({ ...live, expiresAt: later(-1) }).sessions.rotate('t', NOW),
    ).rejects.toMatchObject({ code: 'AUTH-004' });
    await expect(
      setup({ ...live, startedAt: later(-31 * DAY) }).sessions.rotate('t', NOW),
    ).rejects.toMatchObject({ code: 'AUTH-004' });
  });

  it('should end a family only when something was ended, end all of an account and tell if a family lives', async () => {
    expect(await setup(null).sessions.end('t', NOW)).toBeNull();
    expect(await setup(live).sessions.end('t', NOW)).toBe('c1');
    const none = setup(live, 0);
    none.table.updateMany.mockReset().mockResolvedValue({ count: 0 });
    expect(await none.sessions.end('t', NOW)).toBeNull();

    const all = setup(null);
    await all.sessions.endAll('c1', NOW);
    await all.sessions.endAll('c1', NOW, { clientSession: all.table } as never);
    expect(all.table.updateMany).toHaveBeenCalledTimes(2);

    expect(await setup(live).sessions.live('f1', NOW)).toBe(true);
    expect(await setup(null).sessions.live('f1', NOW)).toBe(false);
  });
});
