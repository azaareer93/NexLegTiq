import type { ClsService } from 'nestjs-cls';

import { CourtReportsService } from './court-reports.service';
import { ReferenceContext } from './reference-context';
import type { RequestContext } from '../../common/context/request-context';
import type { UnitOfWork } from '../../database/unit-of-work';

const CALLER = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };

describe('CourtReportsService', () => {
  it("should record the report for the caller's office with an audit row", async () => {
    const cls = {
      get: (key: string) => ({ officeId: 'office-1', userId: 'user-1' })[key],
    } as unknown as ClsService<RequestContext>;
    const tx = {
      courtReport: {
        create: jest.fn().mockResolvedValue({
          id: 'r1',
          name: 'محكمة صلح يطا',
          city: null,
          note: null,
          status: 'PENDING',
          createdAt: new Date('2026-11-28T10:00:00Z'),
        }),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const uow = { run: (work: (t: typeof tx) => unknown) => work(tx) } as unknown as UnitOfWork;
    const service = new CourtReportsService(new ReferenceContext(cls), uow);
    const row = await service.report({ name: 'محكمة صلح يطا' }, CALLER);
    expect(row).toMatchObject({
      id: 'r1',
      status: 'PENDING',
      createdAt: '2026-11-28T10:00:00.000Z',
    });
    expect(tx.courtReport.create.mock.calls[0]?.[0]).toMatchObject({
      data: { name: 'محكمة صلح يطا', officeId: 'office-1', reportedById: 'user-1' },
    });
    expect(tx.auditLog.create.mock.calls[0]?.[0]).toMatchObject({
      data: { entityType: 'CourtReport', action: 'CREATE' },
    });
  });
});
