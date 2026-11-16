import { Injectable } from '@nestjs/common';
import type { PortalUpload } from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { toPortalUpload } from './client-upload-presenter';
import { clientUploadJobId, SCAN_CLIENT_UPLOAD_JOB } from './document-jobs';
import { readUpload } from './upload/multipart';
import { UploadIntake } from './upload/upload-intake';
import { auditRow } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import { BusinessRuleException } from '../../common/errors/app.exception';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';

/** shortcut: a fixed cap on a client's unreviewed uploads (bytes); make it a plan limit if offices ask for more. */
export const MAX_PENDING_CLIENT_BYTES = 250n * 1024n * 1024n;
/**
 * shortcut: an upload still SCANNING after this long lost its scan job (an enqueue that failed after the commit); it stops
 * counting against the cap rather than locking the client out. Re-enqueue such rows with a sweep if they turn up.
 */
const STALE_SCAN_MS = 60 * 60 * 1000;
const NoFields = z.object({});

/** Who sends an upload, already resolved by the portal (D-158): the grant's client, on one of its files. */
export interface ClientUploadTarget {
  readonly fileId: string;
  readonly clientId: string;
  readonly clientUserId: string;
}

/**
 * `POST /portal/files/:id/uploads` (MVP-99, D-187), run in the file's office: the document upload's rules (D-126: type
 * sniffing, 50 MiB, the plan's quota, the file live and not archived) plus a cap on the client's unreviewed uploads
 * (BIZ-027). The upload is stored under `{officeId}/{fileId}/{uploadId}/…`, recorded as SCANNING with an audit row by the
 * portal account, and scanned after the commit; the answer is 202.
 */
@Injectable()
export class ClientUploadIntake {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly intake: UploadIntake,
    private readonly queues: QueueProducer,
  ) {}

  async receive(
    req: Request,
    target: ClientUploadTarget,
    client: ClientInfo,
  ): Promise<PortalUpload> {
    const { file } = await readUpload(req, NoFields);
    await this.intake.beforeStoring(file, () =>
      this.assertRoom(this.prisma.db, target.clientId, 1n),
    );
    const id = uuidV7();
    const stored = await this.intake.store(file, target.fileId, id);
    try {
      const row = await this.uow.run(async (tx, afterCommit) => {
        await this.intake.recheck(tx, { fileId: target.fileId });
        // The client row serialises its uploads: parallel requests cannot pass the cap together.
        await tx.$queryRaw`SELECT 1 FROM clients WHERE id = ${target.clientId}::uuid AND office_id = ${this.officeId()}::uuid FOR UPDATE`;
        await this.assertRoom(tx, target.clientId, BigInt(stored.sizeBytes));
        const created = await tx.clientUpload.create({
          data: {
            id,
            officeId: this.officeId(),
            ...target,
            originalFilename: file.filename,
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
            checksumSha256: stored.checksumSha256,
            storageKey: stored.key,
          },
        });
        await tx.auditLog.create({
          data: {
            ...auditRow(
              {
                officeId: this.officeId(),
                userId: null,
                entityType: 'ClientUpload',
                entityId: id,
                action: 'CREATE',
                newValues: {
                  fileId: target.fileId,
                  name: file.filename,
                  mimeType: stored.mimeType,
                  sizeBytes: stored.sizeBytes,
                  checksumSha256: stored.checksumSha256,
                },
              },
              client,
            ),
            clientUserId: target.clientUserId,
          },
        });
        afterCommit(
          () =>
            this.queues.enqueue(
              QUEUE.OCR,
              SCAN_CLIENT_UPLOAD_JOB,
              { uploadId: id },
              { jobId: clientUploadJobId({ uploadId: id }) },
            ),
          'enqueue client upload scan',
        );
        return created;
      });
      return toPortalUpload(row);
    } catch (error) {
      await this.intake.discard(stored.key);
      throw error;
    }
  }

  /** The client's unreviewed uploads plus this one stay under the cap. */
  private async assertRoom(
    db: Pick<ScopedTransaction, 'clientUpload'>,
    clientId: string,
    adding: bigint,
  ): Promise<void> {
    const { _sum } = await db.clientUpload.aggregate({
      where: {
        clientId,
        OR: [
          { status: 'PENDING_REVIEW' },
          { status: 'SCANNING', createdAt: { gt: new Date(Date.now() - STALE_SCAN_MS) } },
        ],
      },
      _sum: { sizeBytes: true },
    });
    if ((_sum.sizeBytes ?? 0n) + adding > MAX_PENDING_CLIENT_BYTES) {
      throw new BusinessRuleException('BIZ-027', 'Too many unreviewed uploads for this client');
    }
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }
}
