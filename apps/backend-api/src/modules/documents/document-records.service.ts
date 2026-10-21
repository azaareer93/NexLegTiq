import { Injectable } from '@nestjs/common';
import type {
  Document,
  DocumentQuery,
  DocumentText,
  DownloadLink,
  UpdateDocumentRequest,
} from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import { DocumentAccessService } from './document-access.service';
import type { AccessibleDocument } from './document-access.service';
import { UploadIntake } from './upload/upload-intake';
import { changes } from '../../common/audit/changes';
import type { RequestContext } from '../../common/context/request-context';
import {
  AppException,
  BusinessRuleException,
  PermissionDeniedException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { DEFAULT_URL_TTL_SECONDS, StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { truncateUserAgent } from '../auth/client-info';
import { CaseAccessService } from '../legal-files/case-access.service';

/** Characters per page of `GET /documents/:id/text`. */
export const TEXT_PAGE_CHARS = 20_000;

const DOCUMENT_SELECT = {
  id: true,
  fileId: true,
  folderId: true,
  sessionId: true,
  name: true,
  originalFilename: true,
  documentType: true,
  mimeType: true,
  sizeBytes: true,
  currentVersion: true,
  status: true,
  ocrStatus: true,
  processingErrorCode: true,
  isConfidential: true,
  sharedWithClient: true,
  createdAt: true,
  updatedAt: true,
  uploadedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.DocumentSelect;

type DocumentRow = Prisma.DocumentGetPayload<{ select: typeof DOCUMENT_SELECT }>;

const toDocument = ({ sizeBytes, createdAt, updatedAt, ...row }: DocumentRow): Document => ({
  ...row,
  sizeBytes: Number(sizeBytes),
  createdAt: createdAt.toISOString(),
  updatedAt: updatedAt.toISOString(),
});

/** Only a version that passed its malware scan is offered (D-126): PROCESSING and READY. */
function assertDownloadable(status: Document['status'], processingErrorCode: string | null): void {
  if (status === 'QUARANTINED') throw new AppException('STO-004', 'The document was quarantined');
  // FAILED with a processing error code failed after a clean scan (extraction): it is still offered (D-132).
  const scannedClean =
    status === 'PROCESSING' ||
    status === 'READY' ||
    (status === 'FAILED' && processingErrorCode !== null);
  if (!scannedClean) {
    throw new BusinessRuleException('BIZ-015', 'The document is not scanned clean yet');
  }
}

/**
 * Reading and managing documents (MVP-74, D-128): the file's list, a document, metadata changes, soft delete, the
 * download link (audited) and the extracted text. Every route goes through `DocumentAccessService` (the file's scope and
 * the confidential-document rule; 404 otherwise).
 */
@Injectable()
export class DocumentRecordsService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly files: CaseAccessService,
    private readonly documents: DocumentAccessService,
    private readonly storage: StorageService,
    private readonly uow: UnitOfWork,
    private readonly intake: UploadIntake,
  ) {}

  async list(fileId: string, query: DocumentQuery): Promise<PaginatedResult<Document>> {
    await this.files.assertFileAccess(fileId, 'read');
    const search = query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { originalFilename: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {};
    const where: Prisma.DocumentWhereInput = {
      AND: [
        { fileId },
        this.documents.visibleWhere(),
        query.folderId ? { folderId: query.folderId === 'root' ? null : query.folderId } : {},
        query.documentType ? { documentType: query.documentType } : {},
        query.status ? { status: query.status } : {},
        search,
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.db.document.findMany({
        where,
        select: DOCUMENT_SELECT,
        orderBy: [
          ...query.sort.map(({ field, direction }) => ({ [field]: direction })),
          { id: 'asc' },
        ],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.db.document.count({ where }),
    ]);
    return PaginatedResult.of(rows.map(toDocument), {
      page: query.page,
      limit: query.limit,
      total,
    });
  }

  async get(id: string): Promise<Document> {
    await this.documents.assertDocumentAccess(id, 'read');
    return this.load(id);
  }

  /**
   * Renames, retypes or moves a document (uploader or someone who may edit the file, as for a new version, D-126); only
   * the office manager, the uploader or the file's responsible lawyer may set or lift `isConfidential` (as for files,
   * D-096). Under a lock on the file (re-checked: live, not archived, the folder its own) and on the document, so the
   * audit's old values are what the change replaced; only changed fields are written and audited.
   */
  async update(id: string, input: UpdateDocumentRequest, client: ClientInfo): Promise<Document> {
    const document = await this.documents.assertDocumentAccess(id, 'contribute');
    await this.documents.assertMayReplace(document);
    if (input.isConfidential !== undefined) await this.assertMayClassify(document);
    await this.uow.run(async (tx) => {
      await this.intake.recheck(tx, {
        fileId: document.fileId,
        folderId: input.folderId ?? undefined,
      });
      const before = await this.lockDocument(tx, id);
      const { old, next } = changes(before, input);
      if (Object.keys(next).length === 0) return;
      await tx.document.update({ where: { id }, data: next });
      await tx.auditLog.create({ data: this.auditRow(client, id, 'UPDATE', old, next) });
    });
    return this.load(id);
  }

  /** Soft delete (`delete:document`): gone from lists and links; its objects stay until the retention purge. */
  async remove(id: string, client: ClientInfo): Promise<void> {
    const document = await this.documents.assertDocumentAccess(id, 'contribute');
    await this.documents.assertMayReplace(document);
    await this.uow.run(async (tx) => {
      await this.intake.recheck(tx, { fileId: document.fileId });
      const { name } = await this.lockDocument(tx, id);
      await tx.document.update({ where: { id }, data: { deletedAt: new Date() } });
      await tx.auditLog.create({ data: this.auditRow(client, id, 'DELETE', null, { name }) });
    });
  }

  /**
   * A 5-minute link to the current version, served as an attachment under its uploaded name (RFC 5987, Arabic kept,
   * D-085), audited as DOWNLOAD. Only a version that passed its scan is offered — the document's state is the current
   * version's, so an older version (`version` other than the current) is 404 until versions carry their own scan result.
   */
  async download(
    id: string,
    version: number | undefined,
    client: ClientInfo,
  ): Promise<DownloadLink> {
    const { currentVersion } = await this.scannedClean(id);
    if (version !== undefined && version !== currentVersion) throw new ResourceNotFoundException();
    const stored = await this.prisma.db.documentVersion.findFirstOrThrow({
      where: { documentId: id, versionNumber: currentVersion },
      select: { storageKey: true, originalFilename: true, mimeType: true },
    });
    const downloadUrl = await this.storage.presignedGetUrl(stored.storageKey, {
      expiresIn: DEFAULT_URL_TTL_SECONDS,
      filename: stored.originalFilename,
      contentType: stored.mimeType,
    });
    await this.prisma.db.auditLog.create({
      data: this.auditRow(client, id, 'DOWNLOAD', null, { versionNumber: currentVersion }),
    });
    return { downloadUrl, expiresIn: DEFAULT_URL_TTL_SECONDS };
  }

  /**
   * The current version's extracted text, a page at a time (empty until extraction has run); like a download, only once
   * scanned clean, and each page read is an audit row (VIEW).
   */
  async text(id: string, page: number, client: ClientInfo): Promise<DocumentText> {
    const { currentVersion, ocrStatus } = await this.scannedClean(id);
    const row = await this.prisma.db.documentText.findFirst({
      where: { documentId: id, versionNumber: currentVersion },
      select: { text: true },
    });
    const text = row?.text ?? '';
    const start = (page - 1) * TEXT_PAGE_CHARS;
    await this.prisma.db.auditLog.create({
      data: this.auditRow(client, id, 'VIEW', null, {
        versionNumber: currentVersion,
        text: true,
        page,
      }),
    });
    return {
      versionNumber: currentVersion,
      ocrStatus,
      page,
      totalPages: Math.ceil(text.length / TEXT_PAGE_CHARS),
      text: text.slice(start, start + TEXT_PAGE_CHARS),
    };
  }

  /** A live document the caller may read, whose current version passed its malware scan (D-126). */
  private async scannedClean(id: string) {
    await this.documents.assertDocumentAccess(id, 'read');
    const document = await this.prisma.db.document.findFirst({
      where: { id, deletedAt: null },
      select: { status: true, currentVersion: true, ocrStatus: true, processingErrorCode: true },
    });
    if (!document) throw new ResourceNotFoundException();
    assertDownloadable(document.status, document.processingErrorCode);
    return document;
  }

  /** Locks the document row inside the write and reads it again (deleted meanwhile → 404). */
  private async lockDocument(tx: ScopedTransaction, id: string) {
    await tx.$queryRaw`SELECT 1 FROM documents WHERE id = ${id}::uuid AND office_id = ${this.officeId()}::uuid FOR UPDATE`;
    const before = await tx.document.findFirst({
      where: { id, deletedAt: null },
      select: { name: true, documentType: true, folderId: true, isConfidential: true },
    });
    if (!before) throw new ResourceNotFoundException();
    return before;
  }

  private async load(id: string): Promise<Document> {
    const row = await this.prisma.db.document.findFirst({
      where: { id, deletedAt: null },
      select: DOCUMENT_SELECT,
    });
    if (!row) throw new ResourceNotFoundException();
    return toDocument(row);
  }

  /** Classification: the office manager, the uploader or the file's responsible lawyer (as for files, D-096). */
  private async assertMayClassify(document: AccessibleDocument): Promise<void> {
    const userId = this.cls.get('userId');
    if (this.cls.get('role') === 'OFFICE_MANAGER' || document.uploadedById === userId) return;
    const lawyer = await this.prisma.db.legalFile.count({
      where: { id: document.fileId, responsibleLawyerId: userId },
    });
    if (lawyer === 0) throw new PermissionDeniedException();
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office caller in the request context');
    return officeId;
  }

  private auditRow(
    caller: ClientInfo,
    entityId: string,
    action: 'UPDATE' | 'DELETE' | 'DOWNLOAD' | 'VIEW',
    oldValues: Record<string, unknown> | null,
    newValues: Record<string, unknown>,
  ) {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No office caller in the request context');
    return {
      officeId: this.officeId(),
      userId,
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
}
