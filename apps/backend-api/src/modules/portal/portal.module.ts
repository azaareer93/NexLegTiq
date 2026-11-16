import { Module } from '@nestjs/common';

import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { InvoicesModule } from '../invoices/invoices.module';
import { PortalAuthModule } from '../portal-auth/portal-auth.module';

/** The client portal's data routes (MVP-98, D-186) and invoices (MVP-150, D-188); its realm and guards come from `PortalAuthModule`. */
@Module({
  imports: [PortalAuthModule, InvoicesModule],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
