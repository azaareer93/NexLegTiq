import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { fileRedactionContext } from './redaction-context';
import { MAX_PARTS, splitText } from './split-text';
import { SUMMARIZE_DOCUMENT_JOB } from './summary-job';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import { AiAccess } from '../ai/ai-access';
import { AiExecutor, BaseAiService } from '../ai/ai-executor';
import type { AiResult } from '../ai/ai-executor';
import { AiJobRegistry } from '../ai/ai-job-registry';
import type { AiJobContext } from '../ai/ai-job-registry';
import {
  DOCUMENT_SUMMARY_V1,
  DocumentSummaryOutputSchema,
  PartNotesSchema,
} from '../ai/prompts/document-summary.v1';
import type { DocumentSummaryOutput, PartNotes } from '../ai/prompts/document-summary.v1';

export const DOCUMENT_SUMMARY_FEATURE = 'document-summary';
/** Parts read at the same time: two rounds of four fit eight parts and the merge in the job's 300 s. */
const PARALLEL_PARTS = 4;

export const SummarizeDocumentFieldsSchema = z.object({
  documentId: z.uuid(),
  language: z.enum(['AR', 'EN']),
});
export type SummarizeDocumentFields = z.infer<typeof SummarizeDocumentFieldsSchema>;

/**
 * Summarises a document's current version (D-148): read whole when it fits one part, else part by part (the map, four
 * at a time, each `partial` — paid, not counted) and the notes merged (the counted call). The quota is checked once
 * before the first part. A summary of that version and language under the current prompt is reused instead of paying
 * again. The row, a `SUMMARY_GENERATED` timeline event and `document.summary.ready` (to the job's creator) follow.
 */
@Injectable()
export class DocumentSummarizer extends BaseAiService implements OnModuleInit {
  constructor(
    executor: AiExecutor,
    private readonly access: AiAccess,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly realtime: RealtimePublisher,
    private readonly registry: AiJobRegistry,
    private readonly cls: ClsService<RequestContext>,
  ) {
    super(executor);
  }

  onModuleInit(): void {
    this.registry.register(SUMMARIZE_DOCUMENT_JOB, (data, context) => this.run(data, context));
  }

  async run(
    data: Record<string, unknown>,
    context: AiJobContext,
  ): Promise<Record<string, unknown>> {
    const { documentId, language } = SummarizeDocumentFieldsSchema.parse(data);
    const document = await this.prisma.db.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true, fileId: true, currentVersion: true },
    });
    if (!document) throw new ResourceNotFoundException();
    const versionNumber = document.currentVersion;
    const existing = await this.prisma.db.aiSummary.findFirst({
      where: {
        sourceType: 'DOCUMENT',
        sourceId: documentId,
        versionNumber,
        language,
        promptVersion: DOCUMENT_SUMMARY_V1.version,
      },
      select: { id: true },
    });
    if (existing) return { summaryId: existing.id };
    const stored = await this.prisma.db.documentText.findFirst({
      where: { documentId, versionNumber },
      select: { text: true },
    });
    const text = stored?.text.trim() ?? '';
    if (!text) throw new BusinessRuleException('BIZ-020', 'The document has no text to summarise');
    const parts = splitText(text).slice(0, MAX_PARTS);
    const result = await this.summarize(parts, language, document.fileId, context);
    const id = await this.store(document, versionNumber, language, parts.length, result, context);
    return { summaryId: id };
  }

  private async summarize(
    parts: readonly string[],
    language: 'AR' | 'EN',
    fileId: string,
    { userId, signal }: AiJobContext,
  ): Promise<AiResult<DocumentSummaryOutput>> {
    const lang = language === 'EN' ? 'en' : 'ar';
    const base = {
      feature: DOCUMENT_SUMMARY_FEATURE,
      redactionContext: await fileRedactionContext(this.prisma.db, fileId),
      userId,
      signal,
    };
    const [only] = parts;
    if (parts.length === 1 && only !== undefined) {
      return this.execute({
        ...base,
        prompt: DOCUMENT_SUMMARY_V1.whole(lang, only),
        schema: DocumentSummaryOutputSchema,
      });
    }
    // Checked once for the whole summary: the parts are not counted, so they cannot be refused one by one.
    await this.access.assertQuota();
    const notes: PartNotes[] = [];
    for (let start = 0; start < parts.length; start += PARALLEL_PARTS) {
      const round = parts.slice(start, start + PARALLEL_PARTS).map((part, offset) =>
        this.execute({
          ...base,
          partial: true,
          prompt: DOCUMENT_SUMMARY_V1.part(lang, part, start + offset, parts.length),
          schema: PartNotesSchema,
        }),
      );
      notes.push(...(await Promise.all(round)).map((answer) => answer.value));
    }
    return this.execute({
      ...base,
      prompt: DOCUMENT_SUMMARY_V1.merge(lang, notes),
      schema: DocumentSummaryOutputSchema,
    });
  }

  private store(
    document: { id: string; fileId: string },
    versionNumber: number,
    language: 'AR' | 'EN',
    chunks: number,
    { value, provider, model, promptVersion }: AiResult<DocumentSummaryOutput>,
    { aiJobId, userId }: AiJobContext,
  ): Promise<string> {
    return this.uow.run(async (tx, afterCommit) => {
      const row = await tx.aiSummary.create({
        data: {
          officeId: this.officeId(),
          sourceType: 'DOCUMENT',
          sourceId: document.id,
          fileId: document.fileId,
          versionNumber,
          language,
          ...value,
          provider,
          model,
          promptVersion,
          chunks,
          aiJobId,
          createdById: userId,
        },
        select: { id: true },
      });
      // Ids only: a confidential document's name stays out of the file's timeline (D-126).
      await tx.caseTimelineEvent.create({
        data: {
          officeId: this.officeId(),
          fileId: document.fileId,
          eventType: 'SUMMARY_GENERATED',
          sourceType: 'Document',
          sourceId: document.id,
          actorId: userId,
          payload: { summaryId: row.id, versionNumber, language },
        },
      });
      afterCommit(async () => {
        this.realtime.toUser(userId, 'document.summary.ready', {
          documentId: document.id,
          fileId: document.fileId,
        });
      }, 'realtime document.summary.ready');
      return row.id;
    });
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the context of a summary');
    return officeId;
  }
}
