import { Module } from '@nestjs/common';

import { DocumentAccessService } from './document-access.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';
import { UploadIntake } from './upload/upload-intake';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/**
 * Documents: folders (MVP-71, D-119) and uploads with their malware scan (MVP-72, D-126).
 * The `ocr` processor is provided by the worker process only (`WorkerModule`).
 */
@Module({
  imports: [LegalFilesModule],
  controllers: [FoldersController, DocumentsController],
  providers: [FoldersService, DocumentsService, DocumentAccessService, UploadIntake],
  exports: [DocumentAccessService],
})
export class DocumentsModule {}
