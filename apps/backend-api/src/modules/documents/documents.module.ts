import { Module } from '@nestjs/common';

import { CaseDocumentsController, ClientDocumentsController } from './case-documents.controller';
import { ClientUploadIntake } from './client-upload-intake';
import { CaseClientUploadsController, ClientUploadsController } from './client-uploads.controller';
import { ClientUploadsService } from './client-uploads.service';
import { DocumentAccessService } from './document-access.service';
import { DocumentRecordsService } from './document-records.service';
import { DocumentRetry } from './document-retry';
import { DocumentSharingService } from './document-sharing.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { FoldersController } from './folders.controller';
import { FoldersService } from './folders.service';
import { UploadIntake } from './upload/upload-intake';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/**
 * Documents: folders (MVP-71, D-119), uploads with their malware scan (MVP-72, D-126) and the review of client uploads
 * (MVP-99, D-187).
 * The `ocr` processor is provided by the worker process only (`WorkerModule`).
 */
@Module({
  imports: [LegalFilesModule],
  controllers: [
    FoldersController,
    DocumentsController,
    CaseDocumentsController,
    ClientDocumentsController,
    CaseClientUploadsController,
    ClientUploadsController,
  ],
  providers: [
    FoldersService,
    DocumentsService,
    DocumentRecordsService,
    DocumentAccessService,
    UploadIntake,
    DocumentRetry,
    DocumentSharingService,
    ClientUploadIntake,
    ClientUploadsService,
  ],
  exports: [DocumentAccessService, ClientUploadIntake],
})
export class DocumentsModule {}
