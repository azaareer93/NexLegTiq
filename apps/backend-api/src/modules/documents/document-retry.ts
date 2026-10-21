import { Injectable } from '@nestjs/common';
import type { Document } from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import { DocumentAccessService } from './document-access.service';
import { documentJobId, PROCESS_DOCUMENT_JOB, SCAN_DOCUMENT_JOB } from './document-jobs';
import { DocumentRecordsService } from './document-records.service';
import { UploadIntake } from './upload/upload-intake';
import type { RequestContext } from '../../common/context/request-context';
import { BusinessRuleException } from '../../common/errors/app.exception';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { UnitOfWork } from '../../database/unit-of-work';
import { truncateUserAgent } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';

/**
 * `POST /documents/:id/ocr/retry` (D-132): a FAILED document goes back to the step that failed — extraction
 * (`processingErrorCode` set) or the malware scan (none) — and its job is queued again after the commit, under a new job
 * id (the failed one is kept for its record). Anything but FAILED → 422 BIZ-016. Who may retry: whoever may add to the
 * file (`upload:document`, the file not archived — the `contribute` access of D-119).
 */
@Injectable()
export class DocumentRetry {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly documents: DocumentAccessService,
    private readonly records: DocumentRecordsService,
    private readonly intake: UploadIntake,
    private readonly uow: UnitOfWork,
    private readonly queues: QueueProducer,
  ) {}

  async retry(id: string, client: ClientInfo): Promise<Document> {
    const document = await this.documents.assertDocumentAccess(id, 'contribute');
    await this.uow.run(async (tx, afterCommit) => {
      await this.intake.recheck(tx, { fileId: document.fileId });
      const row = await tx.document.findFirst({
        where: { id, deletedAt: null },
        select: { status: true, currentVersion: true, processingErrorCode: true },
      });
      if (row?.status !== 'FAILED') {
        throw new BusinessRuleException('BIZ-016', 'Only a failed document can be retried');
      }
      const step = row.processingErrorCode ? 'process' : 'scan';
      const status = step === 'process' ? 'PROCESSING' : 'SCANNING';
      // Guarded on FAILED: two retries at once queue the work once.
      const { count } = await tx.document.updateMany({
        where: { id, status: 'FAILED' },
        data: { status, processingErrorCode: null },
      });
      if (count === 0)
        throw new BusinessRuleException('BIZ-016', 'Only a failed document can be retried');
      await tx.auditLog.create({ data: this.audit(client, id, row.processingErrorCode, status) });
      const job = { documentId: id, versionNumber: row.currentVersion };
      afterCommit(
        () =>
          this.queues.enqueue(
            QUEUE.OCR,
            step === 'process' ? PROCESS_DOCUMENT_JOB : SCAN_DOCUMENT_JOB,
            job,
            {
              jobId: `${documentJobId(step, job)}-retry-${Date.now()}`,
            },
          ),
        'enqueue document retry',
      );
    });
    return this.records.get(id);
  }

  private audit(client: ClientInfo, id: string, errorCode: string | null, status: string) {
    const userId = this.cls.get('userId');
    const officeId = this.cls.get('officeId');
    if (!userId || !officeId) throw new Error('No office caller in the request context');
    return {
      officeId,
      userId,
      entityType: 'Document',
      entityId: id,
      action: 'UPDATE' as const,
      oldValues: { status: 'FAILED', processingErrorCode: errorCode },
      newValues: { status, retried: true },
      ipAddress: client.ip,
      userAgent: truncateUserAgent(client.userAgent),
      requestId: client.requestId,
    };
  }
}
