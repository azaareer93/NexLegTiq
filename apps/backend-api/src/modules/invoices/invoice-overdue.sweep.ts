import { Injectable } from '@nestjs/common';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { wallClock } from '@nexlegtiq/shared-utils';
import { PinoLogger } from 'nestjs-pino';

import { AuditService } from '../../common/audit/audit.service';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';

/** Daily job (D-162): SENT invoices past their due date (in the office's time zone) become OVERDUE. */
@Injectable()
export class InvoiceOverdueSweep {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantRunner,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InvoiceOverdueSweep.name);
  }

  async run(now = new Date()): Promise<{ readonly marked: number }> {
    // unscoped: the sweep spans every active office; each office is then processed in its own tenant context.
    const offices = await this.prisma
      .unscoped()
      .office.findMany({ where: { isActive: true }, select: { id: true, timezone: true } });
    let marked = 0;
    for (const office of offices) {
      const today = wallClock(now, office.timezone).date;
      marked += await this.tenant.run({ officeId: office.id as OfficeId }, () =>
        this.uow.run(async (tx) => {
          // One statement flips and returns exactly the rows it changed, so a racing payment or void is never audited.
          const changed = await tx.$queryRaw<{ id: string }[]>`
            UPDATE invoices SET status = 'OVERDUE', updated_at = now()
            WHERE office_id = ${office.id}::uuid AND status = 'SENT' AND due_date < ${today}::date
            RETURNING id`;
          const ids = changed.map((invoice) => invoice.id);
          for (const id of ids) {
            await this.audit.log(tx, {
              entityType: 'Invoice',
              entityId: id,
              action: 'UPDATE',
              userId: null,
              oldValues: { status: 'SENT' },
              newValues: { status: 'OVERDUE' },
            });
          }
          return ids.length;
        }),
      );
    }
    this.logger.info({ marked }, 'Overdue invoices marked');
    return { marked };
  }
}
