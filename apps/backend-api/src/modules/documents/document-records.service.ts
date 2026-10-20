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
import { changes } from '../../common/audit/changes';
import type { RequestContext } from '../../common/context/request-context';
import {
  AppException,
  BusinessRuleException,
  PermissionDeniedException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { DEFAULT_URL_TTL_SECONDS, StorageService } from '../../common/storage/storage.service';
import { PrismaService } from '../../database/prisma.service';
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
function assertDownloadable(status: Document['status']): void {
  if (status === 'QUARANTINED') throw new AppException('STO-004', 'The document was quarantined');
  if (status !== 'PROCESSING' && status !== 'READY') {
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
   * D-096). Only changed fields are written and audited.
   */
  async update(id: string, input: UpdateDocumentRequest, client: ClientInfo): Promise<Document> {
    const document = await this.documents.assertDocumentAccess(id, 'contribute');
    await this.documents.assertMayReplace(document);
    if (input.isConfidential !== undefined) await this.assertMayClassify(document);
    if (input.folderId) {
      const folder = await this.prisma.db.documentFolder.count({
        where: { id: input.folderId, fileId: document.fileId },
      });
      if (folder === 0) {
        throw new ValidationException([{ field: 'folderId', message: 'validation.unknownFolder' }]);
      }
    }
    const before = await this.prisma.db.document.findFirstOrThrow({
      where: { id },
      select: { name: true, documentType: true, folderId: true, isConfidential: true },
    });
    const { old, next } = changes(before, input);
    if (Object.keys(next).length > 0) {
      await this.prisma.db.$transaction(async (tx) => {
        const { count } = await tx.document.updateMany({
          where: { id, deletedAt: null },
          data: next,
        });
        if (count === 0) throw new ResourceNotFoundException();
        await tx.auditLog.create({ data: this.auditRow(client, id, 'UPDATE', old, next) });
      });
    }
    return this.load(id);
  }

  /** Soft delete (`delete:document`): gone from lists and links; its objects stay until the retention purge. */
  async remove(id: string, client: ClientInfo): Promise<void> {
    const document = await this.documents.assertDocumentAccess(id, 'contribute');
    await this.documents.assertMayReplace(document);
    await this.prisma.db.$transaction(async (tx) => {
      const { count } = await tx.document.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (count === 0) throw new ResourceNotFoundException();
      const { name } = await tx.document.findFirstOrThrow({
        where: { id },
        select: { name: true },
      });
      await tx.auditLog.create({ data: this.auditRow(client, id, 'DELETE', null, { name }) });
    });
  }

  /**
   * A 5-minute link to the current version, or to `version`, served as an attachment under its uploaded name (RFC 5987,
   * Arabic kept, D-085); audited as DOWNLOAD with the version. Only a document that passed its scan is offered.
   */
  async download(
    id: string,
    version: number | undefined,
    client: ClientInfo,
  ): Promise<DownloadLink> {
    await this.documents.assertDocumentAccess(id, 'read');
    const { status, currentVersion } = await this.prisma.db.document.findFirstOrThrow({
      where: { id },
      select: { status: true, currentVersion: true },
    });
    assertDownloadable(status);
    const stored = await this.prisma.db.documentVersion.findFirst({
      where: { documentId: id, versionNumber: version ?? currentVersion },
      select: { versionNumber: true, storageKey: true, originalFilename: true, mimeType: true },
    });
    if (!stored) throw new ResourceNotFoundException();
    const downloadUrl = await this.storage.presignedGetUrl(stored.storageKey, {
      expiresIn: DEFAULT_URL_TTL_SECONDS,
      filename: stored.originalFilename,
      contentType: stored.mimeType,
    });
    await this.prisma.db.auditLog.create({
      data: this.auditRow(client, id, 'DOWNLOAD', null, { versionNumber: stored.versionNumber }),
    });
    return { downloadUrl, expiresIn: DEFAULT_URL_TTL_SECONDS };
  }

  /** The current version's extracted text, a page at a time (empty until extraction has run). */
  async text(id: string, page: number): Promise<DocumentText> {
    await this.documents.assertDocumentAccess(id, 'read');
    const { currentVersion, ocrStatus } = await this.prisma.db.document.findFirstOrThrow({
      where: { id },
      select: { currentVersion: true, ocrStatus: true },
    });
    const row = await this.prisma.db.documentText.findFirst({
      where: { documentId: id, versionNumber: currentVersion },
      select: { text: true },
    });
    const text = row?.text ?? '';
    const start = (page - 1) * TEXT_PAGE_CHARS;
    return {
      versionNumber: currentVersion,
      ocrStatus,
      page,
      totalPages: Math.ceil(text.length / TEXT_PAGE_CHARS),
      text: text.slice(start, start + TEXT_PAGE_CHARS),
    };
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

  private auditRow(
    caller: ClientInfo,
    entityId: string,
    action: 'UPDATE' | 'DELETE' | 'DOWNLOAD',
    oldValues: Record<string, unknown> | null,
    newValues: Record<string, unknown>,
  ) {
    const officeId = this.cls.get('officeId');
    const userId = this.cls.get('userId');
    if (!officeId || !userId) throw new Error('No office caller in the request context');
    return {
      officeId,
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
