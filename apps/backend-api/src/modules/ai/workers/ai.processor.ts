import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { AppException } from '../../../common/errors/app.exception';
import { getQueue, QUEUE, workerOptions } from '../../../common/queue/queues';
import { parseTenantJob } from '../../../common/queue/tenant-job';
import type { TenantJobData } from '../../../common/queue/tenant-job';
import { TenantProcessor } from '../../../common/queue/tenant-processor';
import { withTimeout } from '../../../common/queue/with-timeout';
import { TenantRunner } from '../../../common/tenancy/tenant-runner';
import { AppConfig } from '../../../config/app-config';
import { PrismaService } from '../../../database/prisma.service';
import { AI_COST_ALERT_JOB, AI_COST_ALERT_SCHEDULE, AiCostAlert } from '../ai-cost-alert';
import { AiJobRegistry } from '../ai-job-registry';
import { AiJobs } from '../ai-jobs';
import type { AiJobData } from '../ai-jobs';
import { AiFinalException } from '../ai-providers';

const AiJobDataSchema = z.looseObject({ aiJobId: z.uuid() });
const COST_ALERT_TIMEOUT_MS = 60_000;

/**
 * Only a provider that was unavailable is worth another attempt (D-130); anything else — and an `AiFinalException`
 * (refused request, no provider or redactor) — fails at once.
 */
const RETRYABLE = new Set(['AI-001', 'AI-002', 'SYS-001']);
const ERROR_CODE = /^[A-Z]+-\d{3}$/;

/** The error code stored on a failed job: an AppException's code, an UnrecoverableError carrying one, else SYS-001. */
export function errorCodeOf(error: unknown): string {
  if (error instanceof AppException) return error.code;
  if (error instanceof UnrecoverableError && ERROR_CODE.test(error.message)) return error.message;
  return 'SYS-001';
}

/**
 * The single consumer of the `ai` queue (D-130): dispatches each job to the handler its feature registered, moves the
 * AiJob row (RUNNING → SUCCEEDED) and lets the creator's app know (`ai.job.completed`). Errors other than an unavailable
 * provider fail at once; the last failed attempt marks the job FAILED with its code and sends `ai.job.failed`.
 */
@Injectable()
@Processor(QUEUE.AI, workerOptions(QUEUE.AI))
export class AiProcessor extends TenantProcessor<AiJobData> implements OnApplicationBootstrap {
  protected readonly schema = AiJobDataSchema;

  constructor(
    tenant: TenantRunner,
    prisma: PrismaService,
    logger: PinoLogger,
    private readonly registry: AiJobRegistry,
    private readonly jobs: AiJobs,
    private readonly costAlert: AiCostAlert,
    private readonly config: AppConfig,
    private readonly moduleRef: ModuleRef,
  ) {
    super(tenant, prisma, logger);
  }

  /**
   * The daily platform cost check (D-144), scheduled by a worker that has the alert configured — one attempt, so a send
   * that failed after delivery never emails twice. It is never removed here: workers without the setting would undo the
   * schedule of those with it (a run without the setting does nothing). A Redis outage is logged.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.aiCostAlert) return;
    try {
      await getQueue(this.moduleRef, QUEUE.AI).upsertJobScheduler(
        AI_COST_ALERT_JOB,
        AI_COST_ALERT_SCHEDULE,
        { name: AI_COST_ALERT_JOB, data: {}, opts: { attempts: 1 } },
      );
    } catch (error) {
      this.logger.warn({ err: error }, 'AI cost alert not scheduled');
    }
  }

  /**
   * The cost check spans every office, so it runs before the tenant checks of `TenantProcessor.process` — only as the
   * scheduler queues it (no office in its data; the name is reserved in the registry), within a minute.
   */
  override async process(job: Job<AiJobData & TenantJobData>): Promise<unknown> {
    if (job.name === AI_COST_ALERT_JOB && !('officeId' in (job.data ?? {}))) {
      return withTimeout(() => this.costAlert.run(), COST_ALERT_TIMEOUT_MS);
    }
    return super.process(job);
  }

  protected async handle(
    job: Job<AiJobData & TenantJobData>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const handler = this.registry.get(job.name);
    if (!handler) throw new UnrecoverableError('SYS-001');
    const { aiJobId } = job.data;
    const started = await this.jobs.start(aiJobId);
    if (!started) return { skipped: 'not runnable' };
    let result: Record<string, unknown>;
    try {
      result = await handler(
        { ...job.data },
        {
          aiJobId,
          userId: started.createdById,
          signal,
        },
      );
    } catch (error) {
      const code = errorCodeOf(error);
      const retry = RETRYABLE.has(code) && !(error instanceof AiFinalException);
      throw retry ? error : new UnrecoverableError(code);
    }
    await this.jobs.succeed(aiJobId, result);
    return result;
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (!job) return;
    const final =
      error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    const tenant = parseTenantJob(job.data);
    const fields = AiJobDataSchema.safeParse(job.data);
    if (!final || !tenant || !fields.success) return;
    try {
      await this.tenant.run({ officeId: tenant.officeId }, () =>
        this.jobs.fail(fields.data.aiJobId, errorCodeOf(error)),
      );
    } catch (markError) {
      this.logger.error(
        { err: markError, aiJobId: fields.data.aiJobId },
        'AI job not marked FAILED',
      );
    }
  }
}
