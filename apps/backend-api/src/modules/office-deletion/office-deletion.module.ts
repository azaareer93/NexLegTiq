import { Module } from '@nestjs/common';

import { OfficeDeletionController } from './office-deletion.controller';
import { OfficeDeletionMailer } from './office-deletion.mailer';
import { OfficeDeletionService } from './office-deletion.service';
import { AuthModule } from '../auth/auth.module';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';

/** Office deletion (MVP-152, D-251): the office's request and cancel, and the platform's cancel and reschedule. */
@Module({
  imports: [AuthModule, PlatformAuthModule],
  controllers: [OfficeDeletionController],
  providers: [OfficeDeletionService, OfficeDeletionMailer],
  exports: [OfficeDeletionService],
})
export class OfficeDeletionModule {}
