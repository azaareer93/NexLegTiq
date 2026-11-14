import { Module } from '@nestjs/common';

import { OfficeSubscriptionService } from './office-subscription.service';
import { PlatformOfficesController } from './platform-offices.controller';
import { PlatformOfficesService } from './platform-offices.service';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';

@Module({
  imports: [PlatformAuthModule],
  controllers: [PlatformOfficesController],
  providers: [PlatformOfficesService, OfficeSubscriptionService],
})
export class PlatformOfficesModule {}
