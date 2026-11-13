import { Module } from '@nestjs/common';

import { InvoiceAccess } from './invoice-access';
import { InvoiceLifecycle } from './invoice-lifecycle.service';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';

/** Invoices (MVP-91, D-162). The overdue sweep (`InvoiceOverdueSweep`) is provided by the worker module. */
@Module({
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoiceLifecycle, InvoiceAccess, InvoiceNumberService],
  exports: [InvoiceAccess],
})
export class InvoicesModule {}
