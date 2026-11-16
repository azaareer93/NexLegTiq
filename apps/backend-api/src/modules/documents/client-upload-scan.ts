import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import { clientUploadJobId } from './document-jobs';
import type { ClientUploadJob } from './document-jobs';
import { ClamavScanner } from './upload/clamav-scanner';
import type { RequestContext } from '../../common/context/request-context';
import { StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import { NotificationService } from '../notifications/notification.service';

export type ClientUploadScanOutcome = 'CLEAN' | 'QUARANTINED' | 'SKIPPED';

/**
 * The malware scan of a client's portal upload (D-187), run by the `ocr` worker in the upload's office:
 * - clean → PENDING_REVIEW, and the file's responsible lawyer is told (CLIENT_UPLOAD);
 * - infected → QUARANTINED, the object deleted and a SECURITY audit row; the client sees the status, the office nothing;
 * - an upload no longer SCANNING (a retry after the first run finished) changes nothing.
 * A scan that cannot finish throws (retried); after the last attempt the upload is FAILED — fail closed.
 */
@Injectable()
export class ClientUploadScan {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly storage: StorageService,
    private readonly scanner: ClamavScanner,
    private readonly notifications: NotificationService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ClientUploadScan.name);
  }

  async run(job: ClientUploadJob, signal: AbortSignal): Promise<ClientUploadScanOutcome> {
    const upload = await this.prisma.db.clientUpload.findFirst({
      where: { id: job.uploadId, status: 'SCANNING' },
      select: {
        storageKey: true,
        originalFilename: true,
        fileId: true,
        client: { select: { displayName: true } },
        file: { select: { responsibleLawyerId: true } },
      },
    });
    if (!upload) return 'SKIPPED';
    const result = await this.scanner.scan(await this.storage.getStream(upload.storageKey), signal);
    const scanning = { id: job.uploadId, status: 'SCANNING' as const };
    if (!result.infected) {
      await this.uow.run(async (tx, afterCommit) => {
        const { count } = await tx.clientUpload.updateMany({
          where: scanning,
          data: { status: 'PENDING_REVIEW' },
        });
        if (count === 0) return;
        afterCommit(
          () =>
            this.notifications.notify(
              [upload.file.responsibleLawyerId],
              {
                type: 'CLIENT_UPLOAD',
                titleKey: 'shell.notifications.clientUpload',
                params: {
                  client: upload.client.displayName.slice(0, 200),
                  name: upload.originalFilename.slice(0, 500),
                },
                link: `/cases/${upload.fileId}?tab=documents`,
              },
              { jobId: `${clientUploadJobId(job)}-received` },
            ),
          'notify client upload',
        );
      });
      return 'CLEAN';
    }
    await this.uow.run(async (tx, afterCommit) => {
      const { count } = await tx.clientUpload.updateMany({
        where: scanning,
        data: { status: 'QUARANTINED' },
      });
      if (count === 0) return;
      await tx.auditLog.create({
        data: {
          officeId: this.officeId(),
          entityType: 'ClientUpload',
          entityId: job.uploadId,
          action: 'SECURITY',
          newValues: { event: 'MALWARE_DETECTED', signature: result.signature },
        },
      });
      afterCommit(() => this.storage.delete(upload.storageKey), 'delete infected client upload');
    });
    this.logger.warn({ uploadId: job.uploadId }, 'Malware found in a client upload');
    return 'QUARANTINED';
  }

  /** After the last failed attempt: never offered for review unscanned. */
  async markFailed(job: ClientUploadJob): Promise<void> {
    await this.prisma.db.clientUpload.updateMany({
      where: { id: job.uploadId, status: 'SCANNING' },
      data: { status: 'FAILED' },
    });
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the job context');
    return officeId;
  }
}
