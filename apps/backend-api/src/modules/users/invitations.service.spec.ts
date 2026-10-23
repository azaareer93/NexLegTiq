import type { ClsService } from 'nestjs-cls';

import { InvitationsService } from './invitations.service';
import type { RequestContext } from '../../common/context/request-context';
import type { QueueProducer } from '../../common/queue/queue-producer';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import type { EntitlementsService } from '../subscriptions/entitlements.service';

const client: ClientInfo = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const FUTURE = new Date(Date.now() + 86_400_000);
const PAST = new Date(Date.now() - 1000);

const invitation = (extra: object = {}) => ({
  id: 'inv-1',
  email: 'nadia@example.test',
  role: 'LAWYER',
  fullName: null,
  expiresAt: FUTURE,
  createdAt: new Date('2026-10-23T10:00:00Z'),
  updatedAt: new Date('2026-10-23T10:00:00Z'),
  invitedBy: { id: 'manager-1', fullName: 'Basma' },
  ...extra,
});

function setup({
  taken = null as object | null,
  pending = null as object | null,
  found = invitation() as object | null,
  revoked = 1,
} = {}) {
  const after: (() => Promise<unknown>)[] = [];
  const officeInvitation = {
    updateMany: jest.fn().mockResolvedValue({ count: revoked }),
    findFirst: jest
      .fn()
      .mockImplementation(({ where }: { where: { email?: string } }) =>
        Promise.resolve(where.email ? pending : found),
      ),
    findMany: jest
      .fn()
      .mockResolvedValue([invitation(), invitation({ id: 'inv-2', expiresAt: PAST })]),
    create: jest.fn().mockResolvedValue({ id: 'inv-1' }),
    update: jest.fn(),
  };
  const tx = { $executeRaw: jest.fn(), officeInvitation, auditLog: { create: jest.fn() } };
  const uow = {
    run: (work: (t: typeof tx, afterCommit: (task: () => Promise<unknown>) => void) => unknown) =>
      work(tx, (task) => after.push(task)),
  } as unknown as UnitOfWork;
  const prisma = {
    db: tx,
    unscoped: () => ({ user: { findUnique: jest.fn().mockResolvedValue(taken) } }),
  } as unknown as PrismaService;
  const cls = {
    get: (key: string) => ({ userId: 'manager-1', officeId: 'office-1' })[key],
  } as unknown as ClsService<RequestContext>;
  const entitlements = { assertUserSlot: jest.fn() };
  const queues = { enqueue: jest.fn() };
  const service = new InvitationsService(
    prisma,
    uow,
    cls,
    entitlements as unknown as EntitlementsService,
    queues as unknown as QueueProducer,
  );
  return { service, tx, entitlements, queues, after };
}

describe('InvitationsService (D-134)', () => {
  it('should close a lapsed invitation, check the seat, store the row and send it after the commit', async () => {
    const { service, tx, entitlements, queues, after } = setup();
    const created = await service.invite(
      { email: 'nadia@example.test', role: 'LAWYER', message: '' },
      client,
    );
    expect(created).toMatchObject({ id: 'inv-1', status: 'PENDING' });
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.officeInvitation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'EXPIRED' } }),
    );
    expect(entitlements.assertUserSlot).toHaveBeenCalled();
    expect(tx.officeInvitation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'nadia@example.test',
        message: null,
        fullName: null,
        invitedById: 'manager-1',
      }),
      select: { id: true },
    });
    expect(queues.enqueue).not.toHaveBeenCalled();
    await Promise.all(after.map((task) => task()));
    expect(queues.enqueue).toHaveBeenCalledWith('email', 'send-invitation', {
      invitationId: 'inv-1',
    });
  });

  it('should refuse an email held by a user or by a pending invitation', async () => {
    await expect(
      setup({ taken: { id: 'u' } }).service.invite({ email: 'a@b.test', role: 'LAWYER' }, client),
    ).rejects.toMatchObject({ code: 'RES-002' });
    const pending = setup({ pending: { id: 'inv-9' } });
    await expect(
      pending.service.invite({ email: 'a@b.test', role: 'LAWYER' }, client),
    ).rejects.toMatchObject({ code: 'RES-002' });
    expect(pending.entitlements.assertUserSlot).not.toHaveBeenCalled();
  });

  it('should list pending invitations, marking lapsed ones EXPIRED', async () => {
    const list = await setup().service.list();
    expect(list.map((row) => row.status)).toEqual(['PENDING', 'EXPIRED']);
  });

  it('should revoke a pending invitation and 404 anything else', async () => {
    const { service, tx } = setup();
    await service.revoke('inv-1', client);
    expect(tx.auditLog.create).toHaveBeenCalled();
    await expect(setup({ revoked: 0 }).service.revoke('inv-1', client)).rejects.toMatchObject({
      code: 'RES-001',
    });
  });

  it('should renew and resend, checking the seat only for a lapsed invitation', async () => {
    const live = setup();
    await live.service.resend('inv-1', client);
    expect(live.entitlements.assertUserSlot).not.toHaveBeenCalled();
    expect(live.tx.officeInvitation.update).toHaveBeenCalled();
    expect(live.after).toHaveLength(1);

    const lapsed = setup({ found: invitation({ expiresAt: PAST }) });
    await lapsed.service.resend('inv-1', client);
    expect(lapsed.entitlements.assertUserSlot).toHaveBeenCalled();

    await expect(setup({ found: null }).service.resend('x', client)).rejects.toMatchObject({
      code: 'RES-001',
    });
    expect(live.tx.officeInvitation.update).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: { expiresAt: expect.any(Date), tokenHash: expect.any(String) },
    });
  });

  it('should refuse a second resend within a minute (RATE-001)', async () => {
    const recent = setup({ found: invitation({ updatedAt: new Date() }) });
    await expect(recent.service.resend('inv-1', client)).rejects.toMatchObject({
      code: 'RATE-001',
    });
    expect(recent.after).toHaveLength(0);
  });
});
