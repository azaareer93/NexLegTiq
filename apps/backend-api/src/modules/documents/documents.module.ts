import { Module } from '@nestjs/common';

import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';
import { StorageUsageService } from './storage-usage.service';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/** Documents: folders now; upload, access and OCR join with their stories (MVP-71, D-119). */
@Module({
  imports: [LegalFilesModule],
  controllers: [FoldersController],
  providers: [FoldersService, StorageUsageService],
  exports: [StorageUsageService],
})
export class DocumentsModule {}
