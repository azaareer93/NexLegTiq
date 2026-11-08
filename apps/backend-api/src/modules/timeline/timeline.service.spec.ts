import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';

import { TimelineService } from './timeline.service';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';
import type { DocumentAccessService } from '../documents/document-access.service';
import type { CaseAccessService } from '../legal-files/case-access.service';

const ID = (n: number) => `01920000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const FILE = ID(900);

function setup(
  context: Partial<Record<keyof RequestContext, string>> = { officeId: 'o1', userId: 'u1' },
) {
  const rows = [3, 2, 1].map((n) => ({
    id: ID(n),
    eventType: n === 3 ? 'FILE_REASSIGNED' : 'TEAM_MEMBER_ADDED',
    sourceType: null,
    sourceId: null,
    occurredAt: new Date(`2026-11-0${n}T10:00:00.000Z`),
    payload:
      n === 3 ? { fromUserId: ID(10), toUserId: ID(11) } : { userId: ID(10), clientId: ID(20) },
    actor: n === 1 ? null : { id: ID(10), fullName: 'Layla' },
  }));
  const db = {
    caseTimelineEvent: { findMany: jest.fn().mockResolvedValue(rows) },
    user: {
      findMany: jest.fn().mockResolvedValue([
        { id: ID(10), fullName: 'Layla' },
        { id: ID(11), fullName: 'Omar' },
      ]),
    },
    document: { findMany: jest.fn().mockResolvedValue([]) },
    client: {
      findMany: jest.fn().mockResolvedValue([{ id: ID(20), displayName: 'Nour Trading' }]),
    },
  };
  const access = { assertFileAccess: jest.fn() };
  const service = new TimelineService(
    { get: (key: keyof RequestContext) => context[key] } as unknown as ClsService<RequestContext>,
    { db } as unknown as PrismaService,
    access as unknown as CaseAccessService,
    { visibleWhere: () => ({ visible: true }) } as unknown as DocumentAccessService,
    { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger,
  );
  return { service, db, access };
}

describe('TimelineService (D-150)', () => {
  it('should record an event in the office of the request, by its caller unless told otherwise', async () => {
    const { service } = setup();
    const create = jest.fn();
    const tx = { caseTimelineEvent: { create } } as never;
    await service.record(tx, {
      fileId: FILE,
      eventType: 'FILE_OPENED',
      payload: { fileNumber: 'F-1' },
    });
    await service.record(tx, { fileId: FILE, eventType: 'SUMMARY_GENERATED', actorId: null });
    expect(create.mock.calls.map(([arg]) => arg)).toEqual([
      {
        data: {
          officeId: 'o1',
          fileId: FILE,
          eventType: 'FILE_OPENED',
          actorId: 'u1',
          payload: { fileNumber: 'F-1' },
        },
      },
      {
        data: {
          officeId: 'o1',
          fileId: FILE,
          eventType: 'SUMMARY_GENERATED',
          actorId: null,
          payload: {},
        },
      },
    ]);
    await expect(
      setup({}).service.record(tx, { fileId: FILE, eventType: 'FILE_OPENED' }),
    ).rejects.toThrow('No office');
  });

  it('should read a page newest first after checking the file, with the names it mentions', async () => {
    const { service, db, access } = setup();
    const page = await service.list(FILE, {
      limit: 2,
      cursor: ID(9),
      types: ['FILE_REASSIGNED', 'TEAM_MEMBER_ADDED'],
    });
    expect(access.assertFileAccess).toHaveBeenCalledWith(FILE, 'read');
    expect(db.caseTimelineEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fileId: FILE, eventType: { in: ['FILE_REASSIGNED', 'TEAM_MEMBER_ADDED'] } },
        take: 3,
        cursor: { id: ID(9) },
        skip: 1,
      }),
    );
    expect(page.items.map((item) => item.id)).toEqual([ID(3), ID(2)]);
    expect(page.nextCursor).toBe(ID(2));
    expect(page.items[0]).toMatchObject({
      portalVisible: false,
      occurredAt: '2026-11-03T10:00:00.000Z',
    });
    expect(page.names).toEqual({ [ID(10)]: 'Layla', [ID(11)]: 'Omar', [ID(20)]: 'Nour Trading' });
  });

  it('should record an event without a caller as the system, and skip ids that are not text', async () => {
    const create = jest.fn();
    await setup({ officeId: 'o1' }).service.record({ caseTimelineEvent: { create } } as never, {
      fileId: FILE,
      eventType: 'FILE_OPENED',
    });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ actorId: null }) });
    const { service, db } = setup();
    db.caseTimelineEvent.findMany.mockResolvedValueOnce([
      {
        id: ID(1),
        eventType: 'TEAM_MEMBER_ADDED',
        sourceType: null,
        sourceId: null,
        occurredAt: new Date(),
        payload: { userId: 5 },
        actor: null,
      },
      {
        id: ID(0),
        eventType: 'FILE_OPENED',
        sourceType: null,
        sourceId: null,
        occurredAt: new Date(),
        payload: null,
        actor: null,
      },
    ]);
    const page = await service.list(FILE, { limit: 20 });
    expect(page.names).toEqual({});
    expect(page.items[1]?.payload).toEqual({});
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('should end the history on a short page and ask no names when none are mentioned', async () => {
    const { service, db } = setup();
    db.caseTimelineEvent.findMany.mockResolvedValueOnce([
      {
        id: ID(1),
        eventType: 'FILE_OPENED',
        sourceType: null,
        sourceId: null,
        occurredAt: new Date(),
        payload: {},
        actor: null,
      },
    ]);
    const page = await service.list(FILE, { limit: 20 });
    expect(page).toMatchObject({ nextCursor: null, names: {} });
    expect(page.items[0]?.portalVisible).toBe(true);
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.client.findMany).not.toHaveBeenCalled();
  });

  it('should hide the name and link of a document the reader may not open, and leave out an unreadable row', async () => {
    const { service, db } = setup();
    const doc = (n: number) => ({
      id: ID(n),
      eventType: 'DOCUMENT_UPLOADED',
      sourceType: 'Document',
      sourceId: ID(100 + n),
      occurredAt: new Date(),
      payload: { name: `doc-${n}.pdf`, versionNumber: 1 },
      actor: null,
    });
    db.caseTimelineEvent.findMany.mockResolvedValueOnce([
      doc(1),
      doc(2),
      { ...doc(3), id: 'not-a-uuid' },
    ]);
    // Only document 101 is still visible to the reader.
    db.document.findMany.mockResolvedValueOnce([{ id: ID(101) }]);
    const page = await service.list(FILE, { limit: 20 });
    expect(db.document.findMany).toHaveBeenCalledWith({
      where: { AND: [{ id: { in: [ID(101), ID(102), ID(103)] } }, { visible: true }] },
      select: { id: true },
    });
    expect(page.items.map((item) => [item.sourceId, item.payload])).toEqual([
      [ID(101), { name: 'doc-1.pdf', versionNumber: 1 }],
      [null, { versionNumber: 1 }],
    ]);
  });
});
