import { Module } from '@nestjs/common';

import { OfficeSubscriptionService } from './office-subscription.service';
import { PlatformOfficesController } from './platform-offices.controller';
import { PlatformOfficesService } from './platform-offices.service';
import { OfficeDeletionModule } from '../office-deletion/office-deletion.module';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';

@Module({
  imports: [PlatformAuthModule, OfficeDeletionModule],
  controllers: [PlatformOfficesController],
  providers: [PlatformOfficesService, OfficeSubscriptionService],
})
export class PlatformOfficesModule {}
