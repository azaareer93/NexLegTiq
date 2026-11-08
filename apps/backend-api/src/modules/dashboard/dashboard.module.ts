import { Module } from '@nestjs/common';

import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { DocumentsModule } from '../documents/documents.module';
import { LegalFilesModule } from '../legal-files/legal-files.module';

/** `GET /dashboard` (MVP-96, D-151). The timeline reader comes from the global TimelineModule. */
@Module({
  imports: [LegalFilesModule, DocumentsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
