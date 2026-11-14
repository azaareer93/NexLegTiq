import { Module } from '@nestjs/common';

import { InvoiceAccess } from './invoice-access';
import { InvoiceLifecycle } from './invoice-lifecycle.service';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoicePdfService } from './pdf/invoice-pdf.service';

/**
 * Invoices (MVP-91, D-162) and their PDFs (MVP-92, D-171). The overdue sweep (`InvoiceOverdueSweep`) and the PDF renderer
 * (`InvoicePdfRenderer`) are provided by the worker module.
 */
@Module({
  controllers: [InvoicesController],
  providers: [
    InvoicesService,
    InvoiceLifecycle,
    InvoiceAccess,
    InvoiceNumberService,
    InvoicePdfService,
  ],
  exports: [InvoiceAccess],
})
export class InvoicesModule {}
