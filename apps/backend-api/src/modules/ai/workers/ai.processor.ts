import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { AppException } from '../../../common/errors/app.exception';
import { QUEUE, workerOptions } from '../../../common/queue/queues';
import { parseTenantJob } from '../../../common/queue/tenant-job';
import type { TenantJobData } from '../../../common/queue/tenant-job';
import { TenantProcessor } from '../../../common/queue/tenant-processor';
import { TenantRunner } from '../../../common/tenancy/tenant-runner';
import { PrismaService } from '../../../database/prisma.service';
import { AiJobRegistry } from '../ai-job-registry';
import { AiJobs } from '../ai-jobs';
import type { AiJobData } from '../ai-jobs';
import { AiFinalException } from '../ai-providers';

const AiJobDataSchema = z.looseObject({ aiJobId: z.uuid() });

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
export class AiProcessor extends TenantProcessor<AiJobData> {
  protected readonly schema = AiJobDataSchema;

  constructor(
    tenant: TenantRunner,
    prisma: PrismaService,
    logger: PinoLogger,
    private readonly registry: AiJobRegistry,
    private readonly jobs: AiJobs,
  ) {
    super(tenant, prisma, logger);
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
