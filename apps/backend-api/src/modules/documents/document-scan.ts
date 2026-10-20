import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import { documentJobId, PROCESS_DOCUMENT_JOB } from './document-jobs';
import type { DocumentJob } from './document-jobs';
import { ClamavScanner } from './upload/clamav-scanner';
import type { RequestContext } from '../../common/context/request-context';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import { CREATE_NOTIFICATION_JOB } from '../notifications/notification-job';
import type { NotificationJob } from '../notifications/notification-job';

export type ScanOutcome = 'CLEAN' | 'QUARANTINED' | 'SUPERSEDED';

/** Only the version a document still mirrors, while it waits for its scan, changes the document. */
const scanning = (job: DocumentJob) => ({
  id: job.documentId,
  currentVersion: job.versionNumber,
  status: 'SCANNING' as const,
});

/**
 * The malware scan of one uploaded version (D-126), run by the `ocr` worker in the document's office:
 * - clean → the document goes to PROCESSING and `process-document` is enqueued (text extraction);
 * - infected → QUARANTINED, the object deleted, a SECURITY audit row and an in-app notification (STO-004) to the uploader;
 * - a version replaced meanwhile is still scanned (its object is deleted when infected) but changes nothing else.
 * A scan that cannot finish throws (retried); after the last attempt the document is FAILED (`markFailed`) — fail closed,
 * it is never treated as clean.
 */
@Injectable()
export class DocumentScan {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly storage: StorageService,
    private readonly scanner: ClamavScanner,
    private readonly queues: QueueProducer,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DocumentScan.name);
  }

  async run(job: DocumentJob, signal: AbortSignal): Promise<ScanOutcome> {
    const version = await this.prisma.db.documentVersion.findFirst({
      where: { documentId: job.documentId, versionNumber: job.versionNumber },
      select: {
        storageKey: true,
        createdById: true,
        document: { select: { name: true, fileId: true } },
      },
    });
    if (!version) return 'SUPERSEDED';
    const result = await this.scanner.scan(
      await this.storage.getStream(version.storageKey),
      signal,
    );
    if (!result.infected) {
      const { count } = await this.prisma.db.document.updateMany({
        where: scanning(job),
        data: { status: 'PROCESSING' },
      });
      if (count === 0) return 'SUPERSEDED';
      await this.queues.enqueue(QUEUE.OCR, PROCESS_DOCUMENT_JOB, job, {
        jobId: documentJobId('process', job),
      });
      return 'CLEAN';
    }
    await this.uow.run(async (tx, afterCommit) => {
      await tx.document.updateMany({ where: scanning(job), data: { status: 'QUARANTINED' } });
      await tx.auditLog.create({
        data: {
          officeId: this.officeId(),
          entityType: 'Document',
          entityId: job.documentId,
          action: 'SECURITY',
          newValues: {
            event: 'MALWARE_DETECTED',
            versionNumber: job.versionNumber,
            signature: result.signature,
          },
        },
      });
      afterCommit(() => this.storage.delete(version.storageKey), 'delete infected object');
      afterCommit(
        () =>
          this.queues.enqueue<NotificationJob>(
            QUEUE.NOTIFICATION,
            CREATE_NOTIFICATION_JOB,
            {
              userId: version.createdById,
              type: 'DOCUMENT_QUARANTINED',
              titleKey: 'shell.notifications.documentQuarantined',
              params: {
                documentId: job.documentId,
                name: version.document.name.slice(0, 500),
                code: 'STO-004',
              },
              link: `/cases/${version.document.fileId}?tab=documents`,
            },
            { jobId: `${documentJobId('scan', job)}-quarantined` },
          ),
        'notify quarantined upload',
      );
    });
    this.logger.warn(
      { documentId: job.documentId, versionNumber: job.versionNumber },
      'Malware found',
    );
    return 'QUARANTINED';
  }

  /** After the last failed attempt: the version could not be scanned, so it is never offered as clean. */
  async markFailed(job: DocumentJob): Promise<void> {
    await this.prisma.db.document.updateMany({ where: scanning(job), data: { status: 'FAILED' } });
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the job context');
    return officeId;
  }
}
