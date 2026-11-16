import { Injectable } from '@nestjs/common';
import type {
  AcceptClientUploadRequest,
  ClientUpload,
  DownloadLink,
  RejectClientUploadRequest,
} from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import { toClientUpload, uploadSelect } from './client-upload-presenter';
import { documentJobId, PROCESS_DOCUMENT_JOB } from './document-jobs';
import { UploadIntake } from './upload/upload-intake';
import { auditRow } from '../../common/audit/audit.service';
import type { AuditEntry } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { DEFAULT_URL_TTL_SECONDS, StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import { CaseAccessService } from '../legal-files/case-access.service';
import { TimelineService } from '../timeline/timeline.service';

/** shortcut: the newest 200 uploads of a file, unpaged; page when a file passes this. */
const MAX_LISTED = 200;

/**
 * The office's side of client uploads (MVP-99, D-187): a file's review queue, a look at an upload, and the review — accept
 * files it as a Document of the file (its Client Uploads folder unless another is chosen; text extraction follows, the
 * scan already ran), reject keeps the row with the reason the client reads and deletes the object. Reviewing needs
 * `upload:document` and the file open for contributions (BIZ-007); one decision per upload, under a lock (BIZ-028; an
 * upload not scanned clean yet is BIZ-015).
 */
@Injectable()
export class ClientUploadsService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly files: CaseAccessService,
    private readonly intake: UploadIntake,
    private readonly storage: StorageService,
    private readonly queues: QueueProducer,
    private readonly timeline: TimelineService,
  ) {}

  async list(fileId: string): Promise<ClientUpload[]> {
    await this.files.assertFileAccess(fileId, 'read');
    const rows = await this.prisma.db.clientUpload.findMany({
      where: { fileId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_LISTED,
      select: uploadSelect,
    });
    return rows.map(toClientUpload);
  }

  /** A 5-minute link to an upload waiting for review (audited DOWNLOAD); nothing else is offered. */
  async download(id: string, client: ClientInfo): Promise<DownloadLink> {
    const upload = await this.find(id);
    await this.files.assertFileAccess(upload.fileId, 'read');
    if (upload.status !== 'PENDING_REVIEW') throw new ResourceNotFoundException();
    const downloadUrl = await this.storage.presignedGetUrl(upload.storageKey, {
      expiresIn: DEFAULT_URL_TTL_SECONDS,
      filename: upload.originalFilename,
      contentType: upload.mimeType,
    });
    await this.prisma.db.auditLog.create({
      data: this.audit(client, { entityId: id, action: 'DOWNLOAD', newValues: {} }),
    });
    return { downloadUrl, expiresIn: DEFAULT_URL_TTL_SECONDS };
  }

  async accept(
    id: string,
    body: AcceptClientUploadRequest,
    client: ClientInfo,
  ): Promise<ClientUpload> {
    const { fileId } = await this.find(id);
    await this.files.assertFileAccess(fileId, 'contribute');
    const userId = this.userId();
    const documentId = uuidV7();
    await this.uow.run(async (tx, afterCommit) => {
      const upload = await this.lockPending(tx, id);
      // Pending uploads are outside the office's storage use (D-187): the quota is checked when one becomes a document.
      await this.intake.assertRoomFor(upload.sizeBytes);
      const folderId = body.folderId ?? (await this.clientUploadsFolder(tx, fileId));
      await this.intake.recheck(tx, { fileId, folderId: folderId ?? undefined });
      const name = body.name ?? upload.originalFilename;
      const stored = {
        originalFilename: upload.originalFilename,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        checksumSha256: upload.checksumSha256,
        storageKey: upload.storageKey,
      };
      // Scanned clean already: straight to text extraction (D-126's PROCESSING step).
      await tx.document.create({
        data: {
          id: documentId,
          officeId: this.officeId(),
          fileId,
          folderId,
          name,
          documentType: body.documentType,
          status: 'PROCESSING',
          uploadedById: userId,
          ...stored,
        },
      });
      await tx.documentVersion.create({
        data: {
          officeId: this.officeId(),
          documentId,
          versionNumber: 1,
          createdById: userId,
          ...stored,
        },
      });
      await tx.clientUpload.update({
        where: { id },
        data: { status: 'ACCEPTED', reviewedById: userId, reviewedAt: new Date(), documentId },
      });
      await this.timeline.record(tx, {
        fileId,
        eventType: 'DOCUMENT_UPLOADED',
        sourceType: 'Document',
        sourceId: documentId,
        actorId: userId,
        payload: { name, versionNumber: 1 },
      });
      await tx.auditLog.createMany({
        data: [
          this.audit(client, {
            entityId: id,
            action: 'UPDATE',
            oldValues: { status: 'PENDING_REVIEW' },
            newValues: { status: 'ACCEPTED', documentId },
          }),
          this.audit(client, {
            entityType: 'Document',
            entityId: documentId,
            action: 'CREATE',
            newValues: {
              fileId,
              folderId,
              name,
              documentType: body.documentType,
              clientUploadId: id,
            },
          }),
        ],
      });
      const job = { documentId, versionNumber: 1 };
      afterCommit(
        () =>
          this.queues.enqueue(QUEUE.OCR, PROCESS_DOCUMENT_JOB, job, {
            jobId: documentJobId('process', job),
          }),
        'enqueue accepted client upload processing',
      );
    });
    return this.get(id);
  }

  async reject(
    id: string,
    body: RejectClientUploadRequest,
    client: ClientInfo,
  ): Promise<ClientUpload> {
    const { fileId } = await this.find(id);
    await this.files.assertFileAccess(fileId, 'contribute');
    await this.uow.run(async (tx, afterCommit) => {
      const upload = await this.lockPending(tx, id);
      await tx.clientUpload.update({
        where: { id },
        data: {
          status: 'REJECTED',
          rejectionReason: body.reason,
          reviewedById: this.userId(),
          reviewedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: this.audit(client, {
          entityId: id,
          action: 'UPDATE',
          oldValues: { status: 'PENDING_REVIEW' },
          newValues: { status: 'REJECTED', rejectionReason: body.reason },
        }),
      });
      afterCommit(() => this.storage.delete(upload.storageKey), 'delete rejected client upload');
    });
    return this.get(id);
  }

  private async get(id: string): Promise<ClientUpload> {
    const row = await this.prisma.db.clientUpload.findFirst({
      where: { id },
      select: uploadSelect,
    });
    if (!row) throw new ResourceNotFoundException();
    return toClientUpload(row);
  }

  private async find(id: string) {
    const upload = await this.prisma.db.clientUpload.findFirst({
      where: { id },
      select: {
        fileId: true,
        status: true,
        storageKey: true,
        originalFilename: true,
        mimeType: true,
      },
    });
    if (!upload) throw new ResourceNotFoundException();
    return upload;
  }

  /** The upload under a lock, still waiting for its review. */
  private async lockPending(tx: ScopedTransaction, id: string) {
    await tx.$queryRaw`SELECT 1 FROM client_uploads WHERE id = ${id}::uuid AND office_id = ${this.officeId()}::uuid FOR UPDATE`;
    const upload = await tx.clientUpload.findFirstOrThrow({ where: { id } });
    if (upload.status === 'ACCEPTED' || upload.status === 'REJECTED') {
      throw new BusinessRuleException('BIZ-028', 'The upload was already reviewed');
    }
    if (upload.status !== 'PENDING_REVIEW') {
      throw new BusinessRuleException('BIZ-015', 'The upload has not been scanned clean');
    }
    return upload;
  }

  /** The file's Client Uploads system folder (D-119); the file's root should it be missing. */
  private async clientUploadsFolder(tx: ScopedTransaction, fileId: string): Promise<string | null> {
    const folder = await tx.documentFolder.findFirst({
      where: { fileId, systemKey: 'CLIENT_UPLOADS' },
      select: { id: true },
    });
    return folder?.id ?? null;
  }

  private audit(
    client: ClientInfo,
    entry: Pick<AuditEntry, 'entityId' | 'action' | 'newValues'> &
      Partial<Pick<AuditEntry, 'entityType' | 'oldValues'>>,
  ) {
    return auditRow(
      {
        officeId: this.officeId(),
        userId: this.userId(),
        entityType: 'ClientUpload',
        oldValues: null,
        ...entry,
      },
      client,
    );
  }

  private userId(): string {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No user in the request context');
    return userId;
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }
}
