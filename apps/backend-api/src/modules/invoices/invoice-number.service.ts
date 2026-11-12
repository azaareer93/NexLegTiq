import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';

import { invoiceNumber } from './invoice-math';
import type { RequestContext } from '../../common/context/request-context';
import { TenantContextMissingError } from '../../common/tenancy/tenant.errors';
import type { ScopedTransaction } from '../../database/unit-of-work';

/**
 * Issues the next invoice number of the current office (D-162), as file numbers are issued (D-095): call it inside the
 * transaction that sends the invoice. The counter row is locked until that transaction ends, so concurrent sends queue,
 * a rollback gives the number back, and numbers are unique and gap-free per office and year.
 */
@Injectable()
export class InvoiceNumberService {
  constructor(private readonly cls: ClsService<RequestContext>) {}

  async next(tx: ScopedTransaction, year: number): Promise<string> {
    const officeId = this.cls.isActive() ? this.cls.get('officeId') : undefined;
    if (!officeId) throw new TenantContextMissingError('invoice number');
    // ON CONFLICT DO NOTHING makes the counter once; the update then takes the row lock and increments it.
    await tx.invoiceNumberSequence.createMany({
      data: [{ officeId, year, lastValue: 0 }],
      skipDuplicates: true,
    });
    const { lastValue } = await tx.invoiceNumberSequence.update({
      where: { officeId_year: { officeId, year } },
      data: { lastValue: { increment: 1 } },
      select: { lastValue: true },
    });
    return invoiceNumber(year, lastValue);
  }
}
