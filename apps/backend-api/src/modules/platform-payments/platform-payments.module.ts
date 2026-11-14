import { Module } from '@nestjs/common';

import { PlatformPaymentsController } from './platform-payments.controller';
import { PlatformPaymentsService } from './platform-payments.service';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';

/** Manual payments and receipts (MVP-170, D-174). The receipt renderer is provided by the worker module. */
@Module({
  imports: [PlatformAuthModule],
  controllers: [PlatformPaymentsController],
  providers: [PlatformPaymentsService],
})
export class PlatformPaymentsModule {}
