import type { ClsService } from 'nestjs-cls';

import type { DocumentAccessService } from './document-access.service';
import { DocumentSharingService } from './document-sharing.service';
import type { RequestContext } from '../../common/context/request-context';
import type { UnitOfWork } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import type { TimelineService } from '../timeline/timeline.service';

const NO_CLIENT = { ip: '127.0.0.1', userAgent: null, requestId: null } satisfies ClientInfo;

function setup(
  row: object | null,
  context: Record<string, string> = { officeId: 'o1', userId: 'u1' },
) {
  const tx = {
    $queryRaw: jest.fn(),
    document: { findFirst: jest.fn().mockResolvedValue(row), update: jest.fn() },
    auditLog: { create: jest.fn() },
  };
  const timeline = { record: jest.fn() };
  const access = { assertDocumentAccess: jest.fn().mockResolvedValue({ id: 'd1', fileId: 'f1' }) };
  const service = new DocumentSharingService(
    { get: (key: string) => context[key] } as unknown as ClsService<RequestContext>,
    access as unknown as DocumentAccessService,
    { run: (work: (t: typeof tx) => Promise<void>) => work(tx) } as unknown as UnitOfWork,
    timeline as unknown as TimelineService,
  );
  return { service, tx, timeline, access };
}
const doc = (over: object = {}) => ({
  name: 'Lease',
  status: 'READY',
  isConfidential: false,
  sharedWithClient: false,
  ...over,
});

describe('DocumentSharingService (D-186)', () => {
  it('should share, audit and record the name on the timeline', async () => {
    const { service, tx, timeline, access } = setup(doc());
    await service.setShared('d1', true, NO_CLIENT);
    expect(access.assertDocumentAccess).toHaveBeenCalledWith('d1', 'contribute');
    expect(tx.document.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { sharedWithClient: true },
    });
    expect(tx.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'UPDATE',
      newValues: { sharedWithClient: true },
    });
    expect(timeline.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ eventType: 'DOCUMENT_SHARED', payload: { name: 'Lease' } }),
    );
  });

  it("should keep a confidential document's name off the timeline", async () => {
    const { service, timeline } = setup(doc({ isConfidential: true }));
    await service.setShared('d1', true, NO_CLIENT);
    expect(timeline.record.mock.calls[0][1].payload).toEqual({});
  });

  it('should unshare with an audit row and no timeline event', async () => {
    const { service, tx, timeline } = setup(doc({ sharedWithClient: true }));
    await service.setShared('d1', false, NO_CLIENT);
    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(timeline.record).not.toHaveBeenCalled();
  });

  it('should write nothing when the value does not change', async () => {
    const { service, tx } = setup(doc({ sharedWithClient: true }));
    await service.setShared('d1', true, NO_CLIENT);
    expect(tx.document.update).not.toHaveBeenCalled();
  });

  it('should refuse a quarantined document, a deleted one and a call without a caller', async () => {
    await expect(
      setup(doc({ status: 'QUARANTINED' })).service.setShared('d1', true, NO_CLIENT),
    ).rejects.toMatchObject({ code: 'STO-004' });
    await expect(setup(null).service.setShared('d1', true, NO_CLIENT)).rejects.toMatchObject({
      code: 'RES-001',
    });
    await expect(setup(doc(), {}).service.setShared('d1', true, NO_CLIENT)).rejects.toThrow(
      'No office caller',
    );
  });
});
