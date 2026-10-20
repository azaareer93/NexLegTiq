import { Injectable } from '@nestjs/common';
import { UploadDocumentFieldsSchema, UploadVersionFieldsSchema } from '@nexlegtiq/shared-contracts';
import type { DocumentUpload, DocumentVersion } from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { DocumentAccessService } from './document-access.service';
import { documentJobId, SCAN_DOCUMENT_JOB } from './document-jobs';
import type { DocumentJob } from './document-jobs';
import { readUpload } from './upload/multipart';
import type { IncomingFile } from './upload/multipart';
import type { StoredUpload } from './upload/store-upload';
import { UploadIntake } from './upload/upload-intake';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException, ValidationException } from '../../common/errors/app.exception';
import { isPrismaError } from '../../common/errors/prisma-error';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { AfterCommit, ScopedTransaction } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';
import { truncateUserAgent } from '../auth/client-info';

/** A client-chosen retry key (api-conventions.md: `Idempotency-Key`). */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Uploads and versions (MVP-72, D-126). An upload is streamed to `{officeId}/{fileId}/{documentId}/{uuid}.{ext}`, recorded
 * as SCANNING with its first version, a DOCUMENT_UPLOADED timeline event and an audit row, and handed to the `ocr` queue
 * for the malware scan after the commit; the answer is 202. A stored object whose write fails afterwards is deleted.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly documents: DocumentAccessService,
    private readonly intake: UploadIntake,
    private readonly queues: QueueProducer,
  ) {}

  async upload(
    req: Request,
    idempotencyKey: string | undefined,
    client: ClientInfo,
  ): Promise<DocumentUpload> {
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      req.resume();
      throw new ValidationException([
        { field: 'Idempotency-Key', message: 'validation.idempotencyKey' },
      ]);
    }
    const replay = idempotencyKey ? await this.byIdempotencyKey(idempotencyKey) : null;
    if (replay) {
      req.resume();
      return replay;
    }
    const { fields, file } = await readUpload(req, UploadDocumentFieldsSchema);
    await this.intake.beforeStoring(file, () => this.intake.assertTargets(fields));
    const documentId = uuidV7();
    const stored = await this.intake.store(file, fields.fileId, documentId);
    try {
      await this.uow.run(async (tx, afterCommit) => {
        await tx.document.create({
          data: {
            id: documentId,
            officeId: this.officeId(),
            fileId: fields.fileId,
            folderId: fields.folderId ?? null,
            sessionId: fields.sessionId ?? null,
            name: file.filename,
            originalFilename: file.filename,
            documentType: fields.documentType,
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
            checksumSha256: stored.checksumSha256,
            storageKey: stored.key,
            status: 'SCANNING',
            isConfidential: fields.isConfidential ?? false,
            uploadedById: this.userId(),
            idempotencyKey: idempotencyKey ?? null,
          },
        });
        await this.recordVersion(tx, afterCommit, documentId, fields.fileId, 1, file, stored, null);
        await tx.auditLog.create({
          data: this.auditRow(client, documentId, 'CREATE', null, {
            fileId: fields.fileId,
            folderId: fields.folderId ?? null,
            sessionId: fields.sessionId ?? null,
            name: file.filename,
            documentType: fields.documentType,
            isConfidential: fields.isConfidential ?? false,
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
            checksumSha256: stored.checksumSha256,
          }),
        });
      });
    } catch (error) {
      await this.intake.discard(stored.key);
      // Two requests with one key raced: the other one created the document.
      if (idempotencyKey && isPrismaError(error) && error.code === 'P2002') {
        const winner = await this.byIdempotencyKey(idempotencyKey);
        if (winner) return winner;
      }
      throw error;
    }
    return { documentId, versionNumber: 1, status: 'SCANNING' };
  }

  /** Stores a new version of a document (n + 1), which the document then mirrors; it is scanned again. */
  async addVersion(documentId: string, req: Request, client: ClientInfo): Promise<DocumentUpload> {
    const { fields, file } = await readUpload(req, UploadVersionFieldsSchema);
    const document = await this.intake.beforeStoring(file, () =>
      this.documents.assertDocumentAccess(documentId, 'contribute'),
    );
    const stored = await this.intake.store(file, document.fileId, documentId);
    try {
      return await this.uow.run(async (tx, afterCommit) => {
        await tx.$queryRaw`SELECT 1 FROM documents WHERE id = ${documentId}::uuid AND office_id = ${this.officeId()}::uuid FOR UPDATE`;
        const before = await tx.document.findFirst({
          where: { id: documentId, deletedAt: null },
          select: { currentVersion: true, status: true, checksumSha256: true },
        });
        if (!before) throw new ResourceNotFoundException();
        const versionNumber = before.currentVersion + 1;
        await tx.document.update({
          where: { id: documentId },
          data: {
            currentVersion: versionNumber,
            originalFilename: file.filename,
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
            checksumSha256: stored.checksumSha256,
            storageKey: stored.key,
            status: 'SCANNING',
            ocrStatus: 'PENDING',
          },
        });
        const note = fields.changeNote || null;
        await this.recordVersion(
          tx,
          afterCommit,
          documentId,
          document.fileId,
          versionNumber,
          file,
          stored,
          note,
        );
        await tx.auditLog.create({
          data: this.auditRow(
            client,
            documentId,
            'UPDATE',
            {
              currentVersion: before.currentVersion,
              status: before.status,
              checksumSha256: before.checksumSha256,
            },
            {
              currentVersion: versionNumber,
              status: 'SCANNING',
              checksumSha256: stored.checksumSha256,
              changeNote: note,
            },
          ),
        });
        return { documentId, versionNumber, status: 'SCANNING' as const };
      });
    } catch (error) {
      await this.intake.discard(stored.key);
      throw error;
    }
  }

  async versions(documentId: string): Promise<DocumentVersion[]> {
    await this.documents.assertDocumentAccess(documentId, 'read');
    const rows = await this.prisma.db.documentVersion.findMany({
      where: { documentId },
      orderBy: { versionNumber: 'desc' },
      select: {
        versionNumber: true,
        originalFilename: true,
        mimeType: true,
        sizeBytes: true,
        checksumSha256: true,
        changeNote: true,
        createdAt: true,
        createdBy: { select: { id: true, fullName: true } },
      },
    });
    return rows.map((row) => ({
      ...row,
      sizeBytes: Number(row.sizeBytes),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async recordVersion(
    tx: ScopedTransaction,
    afterCommit: AfterCommit,
    documentId: string,
    fileId: string,
    versionNumber: number,
    file: IncomingFile,
    stored: StoredUpload,
    changeNote: string | null,
  ): Promise<void> {
    const officeId = this.officeId();
    const userId = this.userId();
    await tx.documentVersion.create({
      data: {
        officeId,
        documentId,
        versionNumber,
        storageKey: stored.key,
        originalFilename: file.filename,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        checksumSha256: stored.checksumSha256,
        changeNote,
        createdById: userId,
      },
    });
    await tx.caseTimelineEvent.create({
      data: {
        officeId,
        fileId,
        eventType: 'DOCUMENT_UPLOADED',
        sourceType: 'Document',
        sourceId: documentId,
        actorId: userId,
        payload: { name: file.filename, versionNumber },
      },
    });
    const job: DocumentJob = { documentId, versionNumber };
    afterCommit(
      () =>
        this.queues.enqueue(QUEUE.OCR, SCAN_DOCUMENT_JOB, job, {
          jobId: documentJobId('scan', job),
        }),
      'enqueue document scan',
    );
  }

  private async byIdempotencyKey(key: string): Promise<DocumentUpload | null> {
    const document = await this.prisma.db.document.findFirst({
      where: { uploadedById: this.userId(), idempotencyKey: key },
      select: { id: true, status: true },
    });
    return document ? { documentId: document.id, versionNumber: 1, status: document.status } : null;
  }

  private auditRow(
    caller: ClientInfo,
    entityId: string,
    action: 'CREATE' | 'UPDATE',
    oldValues: Record<string, unknown> | null,
    newValues: Record<string, unknown>,
  ) {
    return {
      officeId: this.officeId(),
      userId: this.userId(),
      entityType: 'Document',
      entityId,
      action,
      ...(oldValues && { oldValues: oldValues as object }),
      newValues: newValues as object,
      ipAddress: caller.ip,
      userAgent: truncateUserAgent(caller.userAgent),
      requestId: caller.requestId,
    };
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
