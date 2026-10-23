import { Injectable } from '@nestjs/common';
import { UploadDocumentFieldsSchema, UploadVersionFieldsSchema } from '@nexlegtiq/shared-contracts';
import type { DocumentUpload, DocumentVersion } from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { DocumentAccessService } from './document-access.service';
import { documentJobId, NEW_VERSION_STATE, SCAN_DOCUMENT_JOB } from './document-jobs';
import type { DocumentJob } from './document-jobs';
import { discardBody, readUpload } from './upload/multipart';
import type { StoredUpload } from './upload/store-upload';
import { UploadIntake } from './upload/upload-intake';
import { auditRow } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  ResourceConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { isPrismaError } from '../../common/errors/prisma-error';
import { uuidV7 } from '../../common/ids/uuid-v7';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { AfterCommit, ScopedTransaction } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';

/** A client-chosen retry key (api-conventions.md: `Idempotency-Key`). */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

interface NewVersion {
  readonly documentId: string;
  readonly fileId: string;
  readonly versionNumber: number;
  readonly filename: string;
  readonly stored: StoredUpload;
  readonly changeNote: string | null;
  /** A confidential document's name stays out of the file's timeline, which more people see (D-126). */
  readonly confidential: boolean;
}

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
    // A retry with a known key is answered from the first upload; its body is discarded unread.
    const replay = idempotencyKey
      ? await this.replay(idempotencyKey).catch((error: unknown) =>
          discardBody(req).then(() => Promise.reject(error)),
        )
      : null;
    if (replay) {
      await discardBody(req);
      return replay;
    }
    const { fields, file } = await readUpload(req, UploadDocumentFieldsSchema);
    await this.intake.beforeStoring(file, () => this.intake.assertTargets(fields));
    const documentId = uuidV7();
    const stored = await this.intake.store(file, fields.fileId, documentId);
    const confidential = fields.isConfidential ?? false;
    const placement = { folderId: fields.folderId ?? null, sessionId: fields.sessionId ?? null };
    try {
      await this.uow.run(async (tx, afterCommit) => {
        await this.intake.recheck(tx, fields);
        await tx.document.create({
          data: {
            id: documentId,
            officeId: this.officeId(),
            fileId: fields.fileId,
            ...placement,
            name: file.filename,
            originalFilename: file.filename,
            documentType: fields.documentType,
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
            checksumSha256: stored.checksumSha256,
            storageKey: stored.key,
            status: 'SCANNING',
            isConfidential: confidential,
            uploadedById: this.userId(),
            idempotencyKey: idempotencyKey ?? null,
          },
        });
        await this.recordVersion(tx, afterCommit, {
          documentId,
          fileId: fields.fileId,
          versionNumber: 1,
          filename: file.filename,
          stored,
          changeNote: null,
          confidential,
        });
        const created = { fileId: fields.fileId, ...placement, name: file.filename };
        await tx.auditLog.create({
          data: this.auditRow(client, documentId, 'CREATE', null, {
            ...created,
            documentType: fields.documentType,
            isConfidential: confidential,
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
            checksumSha256: stored.checksumSha256,
          }),
        });
      });
    } catch (error) {
      await this.intake.discard(stored.key);
      const winner = await this.raceWinner(error, idempotencyKey);
      if (winner) return winner;
      throw error;
    }
    return { documentId, versionNumber: 1, status: 'SCANNING' };
  }

  /** Stores a new version of a document (n + 1), which the document then mirrors; it is scanned again. */
  async addVersion(documentId: string, req: Request, client: ClientInfo): Promise<DocumentUpload> {
    const { fields, file } = await readUpload(req, UploadVersionFieldsSchema);
    const document = await this.intake.beforeStoring(file, async () => {
      const found = await this.documents.assertDocumentAccess(documentId, 'contribute');
      await this.documents.assertMayReplace(found);
      return found;
    });
    const stored = await this.intake.store(file, document.fileId, documentId);
    try {
      return await this.uow.run(async (tx, afterCommit) => {
        await this.intake.recheck(tx, { fileId: document.fileId });
        await tx.$queryRaw`SELECT 1 FROM documents WHERE id = ${documentId}::uuid AND office_id = ${this.officeId()}::uuid FOR UPDATE`;
        const replaced = { originalFilename: true, mimeType: true, checksumSha256: true } as const;
        const before = await tx.document.findFirst({
          where: { id: documentId, deletedAt: null },
          select: { currentVersion: true, status: true, isConfidential: true, ...replaced },
        });
        if (!before) throw new ResourceNotFoundException();
        const versionNumber = before.currentVersion + 1;
        const mirror = {
          originalFilename: file.filename,
          mimeType: stored.mimeType,
          checksumSha256: stored.checksumSha256,
        };
        await tx.document.update({
          where: { id: documentId },
          data: {
            currentVersion: versionNumber,
            ...mirror,
            sizeBytes: stored.sizeBytes,
            storageKey: stored.key,
            ...NEW_VERSION_STATE,
          },
        });
        const changeNote = fields.changeNote || null;
        await this.recordVersion(tx, afterCommit, {
          documentId,
          fileId: document.fileId,
          versionNumber,
          filename: file.filename,
          stored,
          changeNote,
          confidential: before.isConfidential,
        });
        const { currentVersion, status, originalFilename, mimeType, checksumSha256 } = before;
        await tx.auditLog.create({
          data: this.auditRow(
            client,
            documentId,
            'UPDATE',
            { currentVersion, status, originalFilename, mimeType, checksumSha256 },
            { currentVersion: versionNumber, status: 'SCANNING', ...mirror, changeNote },
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
      take: 100, // listed whole, newest first: a plausible ceiling
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
    version: NewVersion,
  ): Promise<void> {
    const { documentId, fileId, versionNumber, filename, stored, changeNote } = version;
    const officeId = this.officeId();
    const userId = this.userId();
    await tx.documentVersion.create({
      data: {
        officeId,
        documentId,
        versionNumber,
        storageKey: stored.key,
        originalFilename: filename,
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
        payload: version.confidential ? { versionNumber } : { name: filename, versionNumber },
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

  /**
   * The document a key already created, in its current state; null for a new key. A key whose document the caller can no
   * longer reach (deleted, file out of scope) is spent: 409 RES-002.
   */
  private async replay(key: string): Promise<DocumentUpload | null> {
    if (!IDEMPOTENCY_KEY.test(key)) {
      throw new ValidationException([
        { field: 'Idempotency-Key', message: 'validation.idempotencyKey' },
      ]);
    }
    const document = await this.prisma.db.document.findFirst({
      where: { uploadedById: this.userId(), idempotencyKey: key },
      select: { id: true },
    });
    if (!document) return null;
    const visible = await this.prisma.db.document.findFirst({
      where: { AND: [{ id: document.id }, this.documents.visibleWhere()] },
      select: { currentVersion: true, status: true },
    });
    if (!visible) throw new ResourceConflictException('RES-002', 'Idempotency-Key already used');
    return {
      documentId: document.id,
      versionNumber: visible.currentVersion,
      status: visible.status,
    };
  }

  /** Two requests with one key raced (unique violation): the other one created the document. */
  private async raceWinner(error: unknown, key: string | undefined) {
    return key && isPrismaError(error) && error.code === 'P2002' ? this.replay(key) : null;
  }

  private auditRow(
    caller: ClientInfo,
    entityId: string,
    action: 'CREATE' | 'UPDATE',
    oldValues: Record<string, unknown> | null,
    newValues: Record<string, unknown>,
  ) {
    return auditRow(
      {
        officeId: this.officeId(),
        userId: this.userId(),
        entityType: 'Document',
        entityId,
        action,
        oldValues,
        newValues,
      },
      caller,
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
