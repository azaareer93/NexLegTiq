import { Injectable } from '@nestjs/common';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { wallClock } from '@nexlegtiq/shared-utils';
import { PinoLogger } from 'nestjs-pino';

import { AuditService } from '../../common/audit/audit.service';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import { toDbDate } from '../tasks/tasks.repository';

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
      const today = toDbDate(wallClock(now, office.timezone).date);
      marked += await this.tenant.run({ officeId: office.id as OfficeId }, () =>
        this.uow.run(async (tx) => {
          const due = await tx.invoice.findMany({
            where: { status: 'SENT', dueDate: { lt: today } },
            select: { id: true },
          });
          if (due.length === 0) return 0;
          const ids = due.map((invoice) => invoice.id);
          await tx.invoice.updateMany({
            where: { id: { in: ids }, status: 'SENT' },
            data: { status: 'OVERDUE' },
          });
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
