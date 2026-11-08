import { Injectable } from '@nestjs/common';
import { AiSummarySchema } from '@nexlegtiq/shared-contracts';
import type {
  AiJobAccepted,
  AiSummary,
  AiSummaryQuery,
  CreateAiSummaryRequest,
} from '@nexlegtiq/shared-contracts';

import { SUMMARIZE_DOCUMENT_JOB } from './summary-job';
import { AppException, BusinessRuleException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { AiAccess } from '../ai/ai-access';
import { AiJobs } from '../ai/ai-jobs';
import { DOCUMENT_SUMMARY_V1 } from '../ai/prompts/document-summary.v1';
import { DocumentAccessService } from '../documents/document-access.service';

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
  ) {}

  async request({ sourceId, language }: CreateAiSummaryRequest): Promise<SummaryAnswer> {
    await this.access.assertEnabled();
    const document = await this.readable(sourceId);
    if (document.status === 'QUARANTINED') {
      throw new AppException('STO-004', 'The document failed its malware scan');
    }
    if (document.status !== 'READY') {
      throw new BusinessRuleException('BIZ-015', 'The document is not ready yet');
    }
    const [stored] = await this.latest(sourceId, document.currentVersion, language);
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
      fields: { documentId: sourceId, language },
    });
    return { status: 202, accepted };
  }

  /** The newest summary per language of the document's current version (older versions' summaries are stale). */
  async list({ sourceId }: AiSummaryQuery): Promise<AiSummary[]> {
    await this.access.assertEnabled();
    const document = await this.readable(sourceId);
    const rows = await this.latest(sourceId, document.currentVersion);
    const seen = new Set<string>();
    return rows.filter((row) => !seen.has(row.language) && seen.add(row.language)).map(present);
  }

  private async readable(id: string) {
    await this.documents.assertDocumentAccess(id, 'read');
    return this.prisma.db.document.findFirstOrThrow({
      where: { id },
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
