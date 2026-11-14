import { Module } from '@nestjs/common';

import { InvoiceAccess } from './invoice-access';
import { InvoiceLifecycle } from './invoice-lifecycle.service';
import { InvoiceNumberService } from './invoice-number.service';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InvoicePdfService } from './pdf/invoice-pdf.service';
import { RetainerController } from './retainer.controller';
import { RetainerService } from './retainer.service';

/**
 * Invoices (MVP-91, D-162), their PDFs (MVP-92, D-171) and file retainers (MVP-147, D-176). The overdue sweep (`InvoiceOverdueSweep`) and the PDF renderer
 * (`InvoicePdfRenderer`) are provided by the worker module.
 */
@Module({
  controllers: [InvoicesController, RetainerController],
  providers: [
    InvoicesService,
    InvoiceLifecycle,
    InvoiceAccess,
    InvoiceNumberService,
    InvoicePdfService,
    RetainerService,
  ],
  exports: [InvoiceAccess],
})
export class InvoicesModule {}
