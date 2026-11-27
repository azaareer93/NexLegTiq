import { Module } from '@nestjs/common';

import { LegalFileTypesController } from './legal-file-types.controller';
import { LegalFileTypesService } from './legal-file-types.service';
import { PlatformFileTypesController } from './platform-file-types.controller';
import { PlatformFileTypesService } from './platform-file-types.service';
import { PlatformAuthModule } from '../platform-auth/platform-auth.module';

/** Legal file types and sub-types per country (MVP-175, D-261): offices read, the platform admin edits. */
@Module({
  imports: [PlatformAuthModule],
  controllers: [LegalFileTypesController, PlatformFileTypesController],
  providers: [LegalFileTypesService, PlatformFileTypesService],
})
export class LegalFileTypesModule {}
