import { Module } from '@nestjs/common';

import { PlatformUsageController } from './platform-usage.controller';
import { PlatformUsageService } from './platform-usage.service';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';

@Module({
  imports: [PlatformAuthModule],
  controllers: [PlatformUsageController],
  providers: [PlatformUsageService],
})
export class PlatformUsageModule {}
