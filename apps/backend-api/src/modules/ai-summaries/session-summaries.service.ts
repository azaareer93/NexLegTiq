import { Injectable } from '@nestjs/common';
import { AiSummarySchema } from '@nexlegtiq/shared-contracts';
import type {
  AiJobAccepted,
  AiSummary,
  CreateTasksFromSummaryRequest,
  Task,
} from '@nexlegtiq/shared-contracts';
import { z } from 'zod';

import { SUMMARIZE_SESSION_JOB } from './summary-job';
import {
  BusinessRuleException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { AiJobs } from '../ai/ai-jobs';
import { SESSION_SUMMARY_V1 } from '../ai/prompts/session-summary.v1';
import type { ClientInfo } from '../auth/client-info';
import { CaseAccessService } from '../legal-files/case-access.service';
import { todayIn } from '../legal-files/cases.service';
import { TasksService } from '../tasks/tasks.service';

export const SUMMARY_SELECT = {
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
  nextSteps: true,
  riskAssessment: true,
  provider: true,
  model: true,
  promptVersion: true,
  chunks: true,
  createdAt: true,
} as const;

/** The stored row in the contract's shape; its JSON columns were written from the validated model answer. */
export function present(
  row: Prisma.AiSummaryGetPayload<{ select: typeof SUMMARY_SELECT }>,
): AiSummary {
  return AiSummarySchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}

const NextStepsSchema = z.array(
  z.object({ action: z.string(), dueInDays: z.number().int().nullable() }),
);

// The session's last change is in the key: a request after an edit never joins a job reading the older minutes.
const sessionDedupeKey = (sessionId: string, language: string, updatedAt: Date) =>
  `summary:session:${sessionId}:${language}:${updatedAt.getTime()}`;

/**
 * Session summaries (D-179): the hearing's minutes summarised, read and turned into tasks. A session is seen through
 * its file (scope and confidentiality, 404 otherwise). A summary is current while newer than the session's last change.
 */
@Injectable()
export class SessionSummariesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: CaseAccessService,
    private readonly jobs: AiJobs,
    private readonly tasks: TasksService,
  ) {}

  async request(
    sessionId: string,
    language: 'AR' | 'EN',
    force: boolean,
  ): Promise<{ status: 200; summary: AiSummary } | { status: 202; accepted: AiJobAccepted }> {
    const session = await this.readable(sessionId);
    if (!session.minutes?.trim()) {
      throw new BusinessRuleException('BIZ-020', 'The session has no minutes to summarise');
    }
    const [stored] = force ? [] : await this.current(session, language);
    if (stored) return { status: 200, summary: present(stored) };
    const accepted = await this.jobs.enqueue({
      type: SUMMARIZE_SESSION_JOB,
      sourceType: 'SESSION',
      sourceId: sessionId,
      fields: { sessionId, language, ...(force ? { force } : {}) },
      dedupeKey: sessionDedupeKey(sessionId, language, session.updatedAt),
    });
    return { status: 202, accepted };
  }

  /** The newest current summary per language. */
  async list(sessionId: string): Promise<AiSummary[]> {
    const session = await this.readable(sessionId);
    return (await this.current(session)).map(present);
  }

  /**
   * Tasks from the next steps the user picked (D-179), all in one transaction, each `AI_NEXT_STEP` with the summary as
   * its source; nothing is created from a step that was not picked. Due date: the one given, else today in the office's
   * zone plus the step's `dueInDays`, else none.
   */
  async createTasks(
    summaryId: string,
    { selected }: CreateTasksFromSummaryRequest,
    client: ClientInfo,
  ): Promise<Task[]> {
    const summary = await this.prisma.db.aiSummary.findFirst({
      where: { id: summaryId, sourceType: 'SESSION' },
      select: { sourceId: true, fileId: true, nextSteps: true },
    });
    if (!summary) throw new ResourceNotFoundException();
    await this.readable(summary.sourceId);
    const steps = NextStepsSchema.parse(summary.nextSteps);
    const missing = selected.findIndex(({ index }) => index >= steps.length);
    if (missing >= 0) {
      throw new ValidationException([
        { field: `selected.${missing}.index`, message: 'validation.nextStep' },
      ]);
    }
    const { timezone } = await this.prisma.db.office.findFirstOrThrow({
      select: { timezone: true },
    });
    const today = todayIn(timezone, new Date());
    const ids = await this.tasks.createAll(
      selected.map(({ index, title, dueDate, assigneeId }) => {
        const step = steps[index] as (typeof steps)[number];
        const due =
          dueDate ?? (step.dueInDays === null ? undefined : addDays(today, step.dueInDays));
        return {
          title: title ?? step.action.slice(0, 300),
          fileId: summary.fileId,
          priority: 'MEDIUM' as const,
          ...(due ? { dueDate: due } : {}),
          ...(assigneeId ? { assignedToId: assigneeId } : {}),
        };
      }),
      client,
      { type: 'AI_NEXT_STEP', id: summaryId },
    );
    return this.tasks.getCreated(ids);
  }

  private async readable(id: string) {
    const session = await this.prisma.db.session.findFirst({
      where: { AND: [{ id }, { file: { is: this.files.visibleWhere() } }] },
      select: { id: true, minutes: true, updatedAt: true },
    });
    if (!session) throw new ResourceNotFoundException();
    return session;
  }

  private current({ id, updatedAt }: { id: string; updatedAt: Date }, language?: 'AR' | 'EN') {
    return this.prisma.db.aiSummary.findMany({
      where: {
        sourceType: 'SESSION',
        sourceId: id,
        promptVersion: SESSION_SUMMARY_V1.version,
        // Written after the session's last change: an edit of the minutes makes older summaries stale.
        createdAt: { gte: updatedAt },
        ...(language ? { language } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      distinct: ['language'],
      take: language ? 1 : 2,
      select: SUMMARY_SELECT,
    });
  }
}

/** A calendar date plus whole days (UTC arithmetic on a date has no DST). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
