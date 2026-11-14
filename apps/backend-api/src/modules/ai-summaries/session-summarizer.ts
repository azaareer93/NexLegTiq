import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { z } from 'zod';

import { fileRedactionContext } from './redaction-context';
import { SUMMARIZE_SESSION_JOB } from './summary-job';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import { AiExecutor, BaseAiService } from '../ai/ai-executor';
import { AiJobRegistry } from '../ai/ai-job-registry';
import type { AiJobContext } from '../ai/ai-job-registry';
import { SESSION_SUMMARY_V1, SessionSummaryOutputSchema } from '../ai/prompts/session-summary.v1';
import { TimelineService } from '../timeline/timeline.service';

export const SESSION_SUMMARY_FEATURE = 'session-summary';

export const SummarizeSessionFieldsSchema = z.object({
  sessionId: z.uuid(),
  language: z.enum(['AR', 'EN']),
  force: z.boolean().optional(),
});

/**
 * Summarises a hearing's minutes (D-179) in one call: summary, key facts, suggested next steps and a risk reading,
 * stored as an `AiSummary` of source SESSION. A summary is current while it is newer than the session's last change;
 * a job finding a current one (a racing job, a retry) reuses it. `session.summary.ready` goes to the job's creator.
 */
@Injectable()
export class SessionSummarizer extends BaseAiService implements OnModuleInit {
  constructor(
    executor: AiExecutor,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly realtime: RealtimePublisher,
    private readonly registry: AiJobRegistry,
    private readonly cls: ClsService<RequestContext>,
    private readonly timeline: TimelineService,
  ) {
    super(executor);
  }

  onModuleInit(): void {
    this.registry.register(SUMMARIZE_SESSION_JOB, (data, context) => this.run(data, context));
  }

  async run(
    data: Record<string, unknown>,
    context: AiJobContext,
  ): Promise<Record<string, unknown>> {
    const { sessionId, language, force } = SummarizeSessionFieldsSchema.parse(data);
    const session = await this.prisma.db.session.findFirst({
      where: { id: sessionId },
      select: { id: true, fileId: true, minutes: true, updatedAt: true },
    });
    if (!session) throw new ResourceNotFoundException();
    const existing = await this.prisma.db.aiSummary.findFirst({
      where: {
        sourceType: 'SESSION',
        sourceId: sessionId,
        language,
        promptVersion: SESSION_SUMMARY_V1.version,
        ...(force ? { aiJobId: context.aiJobId } : { createdAt: { gte: session.updatedAt } }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (existing) {
      this.ready(context.userId, session);
      return { summaryId: existing.id };
    }
    const minutes = session.minutes?.trim() ?? '';
    if (!minutes)
      throw new BusinessRuleException('BIZ-020', 'The session has no minutes to summarise');
    const { value, provider, model, promptVersion } = await this.execute({
      feature: SESSION_SUMMARY_FEATURE,
      redactionContext: await fileRedactionContext(this.prisma.db, session.fileId),
      userId: context.userId,
      signal: context.signal,
      prompt: SESSION_SUMMARY_V1.whole(language === 'EN' ? 'en' : 'ar', minutes),
      schema: SessionSummaryOutputSchema,
    });
    const summaryId = await this.uow.run(async (tx, afterCommit) => {
      // Edited while the model read it: this summary is of older minutes, so it is not stored (the next request asks again).
      const now = await tx.session.findFirst({
        where: { id: sessionId },
        select: { updatedAt: true },
      });
      if (now?.updatedAt.getTime() !== session.updatedAt.getTime()) return null;
      // Rows of a session have no version (null never collides in the unique key); the count only orders them.
      const regeneration = await tx.aiSummary.count({
        where: { sourceType: 'SESSION', sourceId: sessionId, language, promptVersion },
      });
      const row = await tx.aiSummary.create({
        data: {
          officeId: this.officeId(),
          sourceType: 'SESSION',
          sourceId: sessionId,
          fileId: session.fileId,
          versionNumber: null,
          language,
          summary: value.summary,
          keyFacts: value.keyFacts,
          nextSteps: value.nextSteps,
          riskAssessment: value.riskAssessment,
          provider,
          model,
          promptVersion,
          regeneration,
          aiJobId: context.aiJobId,
          createdById: context.userId,
        },
        select: { id: true },
      });
      // Ids only, as for documents (D-148): the minutes never enter the timeline.
      await this.timeline.record(tx, {
        fileId: session.fileId,
        eventType: 'SUMMARY_GENERATED',
        sourceType: 'Session',
        sourceId: sessionId,
        actorId: context.userId,
        payload: { summaryId: row.id, language },
      });
      afterCommit(
        async () => this.ready(context.userId, session),
        'realtime session.summary.ready',
      );
      return row.id;
    });
    return summaryId ? { summaryId } : { superseded: 1 };
  }

  private ready(userId: string, { id, fileId }: { id: string; fileId: string }): void {
    this.realtime.toUser(userId, 'session.summary.ready', { sessionId: id, fileId });
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the context of a summary');
    return officeId;
  }
}
