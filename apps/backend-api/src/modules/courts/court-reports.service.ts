import { Injectable } from '@nestjs/common';
import type { CourtReport, ReportCourtRequest } from '@nexlegtiq/shared-contracts';

import { ReferenceContext } from './reference-context';
import type { ClientInfo } from '../../common/context/client-info';
import { UnitOfWork } from '../../database/unit-of-work';

/**
 * A court the office could not find in its picker (D-266): recorded for the platform admin, who adds it or dismisses
 * it; the reporting user is notified then (PlatformCourtReportsService).
 */
@Injectable()
export class CourtReportsService {
  constructor(
    private readonly ctx: ReferenceContext,
    private readonly uow: UnitOfWork,
  ) {}

  async report(input: ReportCourtRequest, caller: ClientInfo): Promise<CourtReport> {
    return this.uow.run(async (tx) => {
      const row = await tx.courtReport.create({
        data: { ...input, officeId: this.ctx.officeId(), reportedById: this.ctx.actorId() },
        select: { id: true, name: true, city: true, note: true, status: true, createdAt: true },
      });
      await tx.auditLog.create({
        data: this.ctx.auditRow(caller, 'CourtReport', row.id, 'CREATE', null, { ...input }),
      });
      return { ...row, createdAt: row.createdAt.toISOString() };
    });
  }
}
