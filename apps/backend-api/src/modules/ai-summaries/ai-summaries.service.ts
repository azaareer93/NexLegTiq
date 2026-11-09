import { Injectable } from '@nestjs/common';
import { AiSummaryListItemSchema, AiSummarySchema } from '@nexlegtiq/shared-contracts';
import type {
  AiFeedbackCreated,
  AiFeedbackRequest,
  AiJobAccepted,
  AiSummary,
  AiSummaryListItem,
  AiSummaryQuery,
  CreateAiSummaryRequest,
} from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import { SUMMARIZE_DOCUMENT_JOB, summaryDedupeKey } from './summary-job';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  AppException,
  BusinessRuleException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
import { AiAccess } from '../ai/ai-access';
import { AiJobs } from '../ai/ai-jobs';
import { DOCUMENT_SUMMARY_V1 } from '../ai/prompts/document-summary.v1';
import { DocumentAccessService } from '../documents/document-access.service';
import { CaseAccessService } from '../legal-files/case-access.service';

const SUMMARY_SELECT = {
  id: true,
  sourceType: true,
  sourceId: true,
  fileId: true,
  versionNumber: true,
  language: true,
  summary: true,
  keyFacts: true,
  keyLegalIssues: true,
  parties: true,
  dates: true,
  provider: true,
  model: true,
  promptVersion: true,
  chunks: true,
  createdAt: true,
} as const;

export type SummaryAnswer =
  | { readonly status: 200; readonly summary: AiSummary }
  | { readonly status: 202; readonly accepted: AiJobAccepted };

/**
 * Document summaries over HTTP (D-148). Everything follows the document's own access rule (D-126: its file's scope,
 * confidential documents for their people only); the office's AI switch is checked first (AI-005). A summary of the
 * current version in the language asked is returned at once (200); otherwise the job is queued (202).
 */
@Injectable()
export class AiSummariesService {
  constructor(
    private readonly access: AiAccess,
    private readonly documents: DocumentAccessService,
    private readonly jobs: AiJobs,
    private readonly prisma: PrismaService,
    private readonly files: CaseAccessService,
    private readonly audit: AuditService,
    private readonly uow: UnitOfWork,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  async request({ sourceId, language, force }: CreateAiSummaryRequest): Promise<SummaryAnswer> {
    await this.access.assertEnabled();
    const document = await this.readable(sourceId);
    if (document.status === 'QUARANTINED') {
      throw new AppException('STO-004', 'The document failed its malware scan');
    }
    if (document.status !== 'READY') {
      throw new BusinessRuleException('BIZ-015', 'The document is not ready yet');
    }
    const [stored] = force ? [] : await this.latest(sourceId, document.currentVersion, language);
    if (stored) return { status: 200, summary: present(stored) };
    // Counted without reading the text (it can be millions of characters).
    const withText = await this.prisma.db.documentText.count({
      where: { documentId: sourceId, versionNumber: document.currentVersion, NOT: { text: '' } },
    });
    if (withText === 0) {
      throw new BusinessRuleException('BIZ-020', 'The document has no text to summarise');
    }
    const accepted = await this.jobs.enqueue({
      type: SUMMARIZE_DOCUMENT_JOB,
      sourceType: 'DOCUMENT',
      sourceId,
      fields: {
        documentId: sourceId,
        versionNumber: document.currentVersion,
        language,
        ...(force ? { force } : {}),
      },
      dedupeKey: summaryDedupeKey(sourceId, document.currentVersion, language),
    });
    return { status: 202, accepted };
  }

  /** The newest summary per language of the document's current version (older versions' summaries are stale). */
  async list(query: AiSummaryQuery): Promise<AiSummary[] | AiSummaryListItem[]> {
    await this.access.assertEnabled();
    if (query.fileId) return this.listForFile(query.fileId);
    const sourceId = query.sourceId ?? '';
    const document = await this.readable(sourceId);
    const rows = await this.latest(sourceId, document.currentVersion);
    const seen = new Set<string>();
    return rows.filter((row) => !seen.has(row.language) && seen.add(row.language)).map(present);
  }

  /** The newest summary per document and language, for the current version of every document the caller may see. */
  private async listForFile(fileId: string): Promise<AiSummaryListItem[]> {
    await this.files.assertFileAccess(fileId, 'read');
    const documents = await this.prisma.db.document.findMany({
      where: { AND: [{ fileId }, this.documents.visibleWhere()] },
      select: { id: true, name: true, currentVersion: true },
    });
    if (documents.length === 0) return [];
    const rows = await this.prisma.db.aiSummary.findMany({
      where: {
        sourceType: 'DOCUMENT',
        promptVersion: DOCUMENT_SUMMARY_V1.version,
        OR: documents.map((d) => ({ sourceId: d.id, versionNumber: d.currentVersion })),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: SUMMARY_SELECT,
    });
    const byId = new Map(documents.map((d) => [d.id, d.name]));
    const seen = new Set<string>();
    return rows
      .filter(
        (row) =>
          !seen.has(`${row.sourceId}:${row.language}`) &&
          seen.add(`${row.sourceId}:${row.language}`),
      )
      .slice(0, 200)
      .map((row) =>
        AiSummaryListItemSchema.parse({
          ...present(row),
          source: { type: 'DOCUMENT', id: row.sourceId, name: byId.get(row.sourceId) },
        }),
      );
  }

  /** A rating of a summary the caller can see (its document is visible, D-126); the comment never enters the audit log. */
  async feedback(
    summaryId: string,
    { reason, comment }: AiFeedbackRequest,
  ): Promise<AiFeedbackCreated> {
    const summary = await this.prisma.db.aiSummary.findFirst({
      where: { id: summaryId, sourceType: 'DOCUMENT' },
      select: { sourceId: true },
    });
    if (!summary) throw new ResourceNotFoundException();
    await this.documents.assertDocumentAccess(summary.sourceId, 'read');
    const userId = this.cls.get('userId');
    const officeId = this.cls.get('officeId');
    if (!userId || !officeId) throw new Error('No office caller in the request context');
    const id = await this.uow.run(async (tx) => {
      const row = await tx.aiFeedback.create({
        data: { officeId, summaryId, userId, reason, comment: comment || null },
        select: { id: true },
      });
      await this.audit.log(tx, {
        entityType: 'AiFeedback',
        entityId: row.id,
        action: 'CREATE',
        newValues: { summaryId, reason, hasComment: Boolean(comment) },
      });
      return row.id;
    });
    return { id };
  }

  private async readable(id: string) {
    await this.documents.assertDocumentAccess(id, 'read');
    return this.prisma.db.document.findFirstOrThrow({
      where: { id, deletedAt: null },
      select: { status: true, currentVersion: true },
    });
  }

  private latest(sourceId: string, versionNumber: number, language?: 'AR' | 'EN') {
    return this.prisma.db.aiSummary.findMany({
      where: {
        sourceType: 'DOCUMENT',
        sourceId,
        versionNumber,
        promptVersion: DOCUMENT_SUMMARY_V1.version,
        ...(language ? { language } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: language ? 1 : 10,
      select: SUMMARY_SELECT,
    });
  }
}

/** The stored row in the contract's shape; its JSON columns were written from the validated model answer. */
function present(row: Prisma.AiSummaryGetPayload<{ select: typeof SUMMARY_SELECT }>): AiSummary {
  return AiSummarySchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}
