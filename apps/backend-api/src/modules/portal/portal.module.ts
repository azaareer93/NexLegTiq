import { Module } from '@nestjs/common';

import { PortalController } from './portal.controller';
import { PortalService } from './portal.service';
import { PortalAuthModule } from '../portal-auth/portal-auth.module';

/** The client portal's data routes (MVP-98, D-186); its realm and guards come from `PortalAuthModule`. */
@Module({
  imports: [PortalAuthModule],
  controllers: [PortalController],
  providers: [PortalService],
})
export class PortalModule {}
