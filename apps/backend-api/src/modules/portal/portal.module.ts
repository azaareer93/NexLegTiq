import { Module } from '@nestjs/common';

import { PortalInvoicesService } from './portal-invoices.service';
import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { DocumentsModule } from '../documents/documents.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { PortalAuthModule } from '../portal-auth/portal-auth.module';

/** The client portal's data routes (MVP-98, D-186), client uploads (MVP-99, D-187) and invoices (MVP-150, D-188); its realm and guards come from `PortalAuthModule`. */
@Module({
  imports: [PortalAuthModule, DocumentsModule, InvoicesModule],
  controllers: [PortalController],
  providers: [PortalService, PortalInvoicesService],
})
export class PortalModule {}
