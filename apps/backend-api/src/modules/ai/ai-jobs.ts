import { Injectable } from '@nestjs/common';
import type { AiJob, AiJobAccepted } from '@nexlegtiq/shared-contracts';
import type { AiSourceType } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { AiAccess } from './ai-access';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import type { JobFields } from '../../common/queue/tenant-job';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';

/** What a feature hands to the worker: its job name, what it is about, and the job's own fields (ids, language). */
export interface NewAiJob {
  readonly type: string;
  readonly sourceType?: AiSourceType;
  readonly sourceId?: string;
  readonly fields?: Readonly<Record<string, unknown>> & JobFields;
}

/** What an `ai` job carries besides the feature's fields: the AiJob row it moves. */
export interface AiJobData {
  readonly aiJobId: string;
}

const JOB_SELECT = {
  id: true,
  type: true,
  status: true,
  sourceType: true,
  sourceId: true,
  errorCode: true,
  result: true,
  createdAt: true,
  updatedAt: true,
  finishedAt: true,
} satisfies Prisma.AiJobSelect;

/**
 * Asynchronous AI work (D-014, D-130): `enqueue` checks availability (AI-001/005, AUTH-102/103), writes the AiJob row
 * and queues `ai/<type>` after the commit; the HTTP answer is 202 `{jobId, status}`. The worker moves the row
 * (`start`/`succeed`/`fail`) and pushes `ai.job.completed|failed` to its creator. `GET /jobs/:id` shows a job to its
 * creator only — it may be about a file someone else cannot see.
 */
@Injectable()
export class AiJobs {
  constructor(
    private readonly access: AiAccess,
    private readonly uow: UnitOfWork,
    private readonly queues: QueueProducer,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimePublisher,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  async enqueue({ type, sourceType, sourceId, fields = {} }: NewAiJob): Promise<AiJobAccepted> {
    const userId = this.cls.get('userId');
    const officeId = this.cls.get('officeId');
    if (!userId || !officeId) throw new Error('No caller in the context of an AI job');
    await this.access.assertAvailable();
    const job = await this.uow.run(async (tx, afterCommit) => {
      const row = await tx.aiJob.create({
        data: { officeId, type, sourceType, sourceId, createdById: userId },
        select: { id: true, status: true },
      });
      afterCommit(
        () =>
          this.queues.enqueue<AiJobData>(
            QUEUE.AI,
            type,
            { ...fields, aiJobId: row.id },
            { jobId: row.id },
          ),
        `enqueue ai/${type}`,
      );
      return row;
    });
    return { jobId: job.id, status: job.status };
  }

  async get(id: string): Promise<AiJob> {
    const job = await this.prisma.db.aiJob.findFirst({
      where: { id, createdById: this.cls.get('userId') },
      select: JOB_SELECT,
    });
    if (!job) throw new ResourceNotFoundException();
    return {
      ...job,
      result: (job.result as Record<string, unknown> | null) ?? null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
    };
  }

  /** The worker took the job; returns its creator (for the result notification), or null when it is not ours to run. */
  async start(id: string): Promise<{ createdById: string } | null> {
    const { count } = await this.prisma.db.aiJob.updateMany({
      where: { id, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: new Date() },
    });
    if (count === 0) return null;
    return this.prisma.db.aiJob.findFirstOrThrow({ where: { id }, select: { createdById: true } });
  }

  async succeed(id: string, result: Record<string, unknown>): Promise<void> {
    const job = await this.prisma.db.aiJob.update({
      where: { id },
      data: {
        status: 'SUCCEEDED',
        result: result as Prisma.InputJsonObject,
        finishedAt: new Date(),
      },
      select: { createdById: true },
    });
    this.realtime.toUser(job.createdById, 'ai.job.completed', { jobId: id });
  }

  async fail(id: string, errorCode: string): Promise<void> {
    const { count } = await this.prisma.db.aiJob.updateMany({
      where: { id, status: { not: 'SUCCEEDED' } },
      data: { status: 'FAILED', errorCode, finishedAt: new Date() },
    });
    if (count === 0) return;
    const job = await this.prisma.db.aiJob.findFirstOrThrow({
      where: { id },
      select: { createdById: true },
    });
    this.realtime.toUser(job.createdById, 'ai.job.failed', { jobId: id });
  }
}
