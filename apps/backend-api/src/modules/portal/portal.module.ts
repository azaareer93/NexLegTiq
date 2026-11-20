import { Module } from '@nestjs/common';

import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { DocumentsModule } from '../documents/documents.module';
import { PortalAuthModule } from '../portal-auth/portal-auth.module';

/** The client portal's data routes (MVP-98, D-186) and client uploads (MVP-99, D-187); its realm and guards come from `PortalAuthModule`. */
@Module({
  imports: [PortalAuthModule, DocumentsModule],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
