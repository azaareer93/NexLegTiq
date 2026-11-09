import type { ClsService } from 'nestjs-cls';

import { PortalAccessService } from './portal-access.service';
import type { PortalSessions } from './portal-sessions';
import type { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import type { QueueProducer } from '../../common/queue/queue-producer';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';

const CLIENT = { ip: '203.0.113.7', userAgent: null, requestId: null };
const NOW = Date.now();

interface Options {
  client?: object | null;
  contact?: object | null;
  account?: object | null;
  grant?: object | null;
  pending?: object | null;
  revoked?: number;
  user?: string | null;
  office?: string | null;
  role?: string;
  hidden?: object | null;
}

function setup(options: Options = {}) {
  const { client, contact, account, grant, pending, revoked, user, office, role, hidden } = {
    client: { id: 'c1' },
    contact: { id: 'p1' },
    account: null,
    grant: null,
    pending: null,
    revoked: 1,
    user: 'm1',
    office: 'o1',
    role: 'LAWYER',
    hidden: null,
    ...options,
  };
  const tx = {
    client: { findFirst: jest.fn().mockResolvedValue(client) },
    legalFile: { findFirst: jest.fn().mockResolvedValue(hidden) },
    contactPerson: { findFirst: jest.fn().mockResolvedValue(contact) },
    clientPortalAccess: {
      findFirst: jest.fn().mockResolvedValue(grant),
      updateMany: jest.fn().mockResolvedValue({ count: revoked }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    clientInvitation: {
      updateMany: jest.fn().mockResolvedValue({ count: revoked }),
      findFirst: jest.fn().mockResolvedValue(pending),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({
        id: 'i1',
        email: 'l@x.test',
        contactPersonId: null,
        expiresAt: new Date(NOW + 86_400_000),
        createdAt: new Date(NOW),
      }),
    },
  };
  const after: (() => Promise<unknown>)[] = [];
  const uow = {
    run: jest.fn((work: (t: unknown, a: (task: () => Promise<unknown>) => void) => unknown) =>
      work(tx, (task) => after.push(task)),
    ),
  };
  const raw = {
    clientUser: {
      findUnique: jest.fn().mockResolvedValue(account),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const queues = { enqueue: jest.fn() };
  const sessions = { endAll: jest.fn() };
  const audit = { log: jest.fn() };
  const service = new PortalAccessService(
    { unscoped: () => raw, db: tx } as unknown as PrismaService,
    uow as unknown as UnitOfWork,
    audit as unknown as AuditService,
    queues as unknown as QueueProducer,
    sessions as unknown as PortalSessions,
    {
      get: (key: string) =>
        (({ userId: user, role, officeId: office }) as Record<string, unknown>)[key] ?? undefined,
    } as unknown as ClsService<RequestContext>,
  );
  return { service, tx, raw, after, queues, sessions, audit };
}

describe('PortalAccessService (D-158)', () => {
  it('should create a pending invitation, audit it and queue the email after the commit', async () => {
    const { service, tx, after, queues, audit } = setup();
    const row = await service.invite('c1', { email: 'l@x.test', contactPersonId: 'p1' }, CLIENT);
    expect(row).toMatchObject({ id: 'i1', status: 'PENDING' });
    expect(tx.clientInvitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ officeId: 'o1', invitedById: 'm1', contactPersonId: 'p1' }),
      }),
    );
    expect(audit.log).toHaveBeenCalled();
    await after[0]?.();
    expect(queues.enqueue).toHaveBeenCalledWith('email', 'send-client-invitation', {
      invitationId: 'i1',
    });
  });

  it('should refuse an unknown client or contact, an existing grant and a pending invitation', async () => {
    const input = { email: 'l@x.test' };
    await expect(setup({ client: null }).service.invite('c1', input, CLIENT)).rejects.toMatchObject(
      { code: 'RES-001' },
    );
    await expect(
      setup({ contact: null }).service.invite('c1', { ...input, contactPersonId: 'p9' }, CLIENT),
    ).rejects.toMatchObject({ code: 'VAL-001' });
    await expect(
      setup({ account: { id: 'u1' }, grant: { id: 'g1' } }).service.invite('c1', input, CLIENT),
    ).rejects.toMatchObject({ code: 'RES-002' });
    // An account elsewhere, with no grant here, is fine.
    await expect(
      setup({ account: { id: 'u1' } }).service.invite('c1', input, CLIENT),
    ).resolves.toBeDefined();
    await expect(
      setup({ pending: { id: 'x' } }).service.invite('c1', input, CLIENT),
    ).rejects.toMatchObject({ code: 'RES-002' });
  });

  it('should refuse inviting a client with a confidential file the caller may not expose, except for the manager', async () => {
    const input = { email: 'l@x.test' };
    const file = { id: 'f1' };
    const denied = setup({ hidden: file });
    await expect(denied.service.invite('c1', input, CLIENT)).rejects.toMatchObject({
      code: 'AUTH-100',
    });
    expect(denied.tx.legalFile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isConfidential: true,
          NOT: { responsibleLawyerId: 'm1' },
        }),
      }),
    );
    const manager = setup({ hidden: file, role: 'OFFICE_MANAGER' });
    await expect(manager.service.invite('c1', input, CLIENT)).resolves.toBeDefined();
    expect(manager.tx.legalFile.findFirst).not.toHaveBeenCalled();
  });

  it('should fail loudly without a caller or an office in the context', async () => {
    await expect(
      setup({ user: null }).service.invite('c1', { email: 'a@b.test' }, CLIENT),
    ).rejects.toThrow('user');
    await expect(
      setup({ office: null }).service.invite('c1', { email: 'a@b.test' }, CLIENT),
    ).rejects.toThrow('office');
  });

  it('should list accounts with live access and pending invitations', async () => {
    const { service, tx, raw } = setup();
    tx.clientPortalAccess.findMany.mockResolvedValue([
      { id: 'g1', clientUserId: 'u1', contactPersonId: null, createdAt: new Date(NOW) },
      { id: 'g2', clientUserId: 'gone', contactPersonId: 'p1', createdAt: new Date(NOW) },
    ]);
    tx.clientInvitation.findMany.mockResolvedValue([
      {
        id: 'i1',
        email: 'a@b.test',
        contactPersonId: null,
        expiresAt: new Date(0),
        createdAt: new Date(NOW),
      },
    ]);
    raw.clientUser.findMany.mockResolvedValue([{ id: 'u1', email: 'l@x.test', fullName: 'Layla' }]);
    const result = await service.list('c1');
    expect(result.users).toHaveLength(1);
    expect(result.users[0]).toMatchObject({ id: 'g1', fullName: 'Layla' });
    expect(result.invitations[0]?.status).toBe('EXPIRED');
    expect(result.users[0]).not.toHaveProperty('lastLoginAt');
    await expect(setup({ client: null }).service.list('c1')).rejects.toMatchObject({
      code: 'RES-001',
    });
  });

  it("should revoke a grant, audit it and end the account's sessions after the commit", async () => {
    const { service, tx, after, sessions } = setup();
    tx.clientPortalAccess.findFirst.mockResolvedValue({ clientUserId: 'u1' });
    await service.revokeAccess('c1', 'g1', CLIENT);
    await after[0]?.();
    expect(sessions.endAll).toHaveBeenCalledWith('u1', expect.any(Date));
    const missing = setup();
    await expect(missing.service.revokeAccess('c1', 'g1', CLIENT)).rejects.toMatchObject({
      code: 'RES-001',
    });
    const raced = setup({ revoked: 0 });
    raced.tx.clientPortalAccess.findFirst.mockResolvedValue({ clientUserId: 'u1' });
    await expect(raced.service.revokeAccess('c1', 'g1', CLIENT)).rejects.toMatchObject({
      code: 'RES-001',
    });
  });

  it('should withdraw a pending invitation, and 404 anything else', async () => {
    const { service, audit } = setup();
    await service.revokeInvitation('c1', 'i1', CLIENT);
    expect(audit.log).toHaveBeenCalled();
    await expect(
      setup({ revoked: 0 }).service.revokeInvitation('c1', 'i1', CLIENT),
    ).rejects.toMatchObject({ code: 'RES-001' });
  });
});
