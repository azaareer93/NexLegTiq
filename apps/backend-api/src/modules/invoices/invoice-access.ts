import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';

type InvoiceStatus = Prisma.InvoiceWhereInput['status'] & string;

/** Which invoices the caller may see, and the locked read every change starts with (D-162). */
@Injectable()
export class InvoiceAccess {
  constructor(private readonly cls: ClsService<RequestContext>) {}

  caller() {
    const userId = this.cls.get('userId');
    const role = this.cls.get('role');
    const officeId = this.cls.get('officeId');
    if (!userId || !role || !officeId) throw new Error('No office caller in the request context');
    return { userId, role, officeId, permissions: this.cls.get('permissions') ?? [] };
  }

  /** The files an invoice may name for this caller: all (`view:all:invoices`) or assigned ones, confidentiality applied. */
  fileScope(): Prisma.LegalFileWhereInput {
    const { userId, role, permissions } = this.caller();
    // The rule of caseScopeWhere (D-051, D-096) with a paralegal term that is false, not NULL, when the file has no
    // paralegal: the scope is negated below, and NOT (NULL) matches nothing in SQL.
    const assigned: Prisma.LegalFileWhereInput = {
      OR: [
        { responsibleLawyerId: userId },
        { AND: [{ responsibleParalegalId: { not: null } }, { responsibleParalegalId: userId }] },
        { teamMembers: { some: { userId } } },
      ],
    };
    if (!permissions.includes('view:all:invoices')) return assigned;
    if (role === 'OFFICE_MANAGER') return {};
    return { OR: [{ isConfidential: false }, assigned] };
  }

  /**
   * Invoices the caller may see: the file of a per-file invoice is visible to them, and so are **all** the files of a
   * consolidated one (read from its lines, which survive a void). Confidential files: office manager and assigned only.
   */
  visibleWhere(): Prisma.InvoiceWhereInput {
    const scope = this.fileScope();
    // The office manager's scope is "every file": an empty filter (NOT {} would match nothing).
    if (Object.keys(scope).length === 0) return {};
    return {
      AND: [
        { OR: [{ fileId: null }, { file: scope }] },
        { lines: { none: { fileId: { not: null }, NOT: { file: scope } } } },
      ],
    };
  }

  /** The invoice for a change: row-locked (concurrent changes queue), visible to the caller, in one of `allowed`. */
  async locked(tx: ScopedTransaction, id: string, allowed: readonly InvoiceStatus[]) {
    const { officeId } = this.caller();
    await tx.$queryRaw`SELECT 1 FROM invoices WHERE id = ${id}::uuid AND office_id = ${officeId}::uuid FOR UPDATE`;
    const row = await tx.invoice.findFirst({
      where: { AND: [{ id }, this.visibleWhere()] },
      select: {
        id: true,
        status: true,
        currency: true,
        fileId: true,
        invoiceNumber: true,
        dueDate: true,
        taxRatePercent: true,
        total: true,
        lines: {
          select: {
            fileId: true,
            timeEntryId: true,
            description: true,
            quantity: true,
            unitPrice: true,
            amount: true,
          },
        },
      },
    });
    if (!row) throw new ResourceNotFoundException();
    if (!allowed.includes(row.status)) {
      throw new BusinessRuleException('BIZ-006', 'The invoice cannot change in its current state');
    }
    return row;
  }
}
