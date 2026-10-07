import { OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';
import type { z } from 'zod';

import { QUEUE_POLICY } from './queues';
import type { QueueName } from './queues';
import { parseTenantJob } from './tenant-job';
import type { TenantJobData } from './tenant-job';
import { withTimeout } from './with-timeout';
import type { PrismaService } from '../../database/prisma.service';
import type { TenantRunner } from '../tenancy/tenant-runner';

/** Log fields for one job attempt: worker logs have no HTTP request, so the request id comes from the payload (D-076). */
export function jobLogFields(job: Job, requestId: string | null) {
  return {
    queue: job.queueName,
    jobId: job.id,
    job: job.name,
    attempt: job.attemptsMade + 1,
    requestId,
  };
}

/** Result of a job skipped because its office was suspended after it was enqueued. */
export const SKIPPED_OFFICE_INACTIVE = { skipped: 'OFFICE_INACTIVE' } as const;

/**
 * Base of every processor (D-084):
 * - the tenant part of the payload must be valid and the job-specific part must match `schema`; otherwise the job fails
 *   at once (`UnrecoverableError`, no retries) — Redis is a trust boundary;
 * - `handle` runs in the job's office through TenantRunner (the scoped Prisma client works as in a request), and is
 *   skipped when the office has been suspended since (D-082: a suspended office does nothing);
 * - the queue's timeout fails the attempt and aborts `signal`: handlers pass it to HTTP/SDK calls and check it between
 *   steps, so a timed-out attempt stops instead of running alongside its retry. Handlers must be idempotent.
 *
 * ```ts
 * @Processor(QUEUE.OCR, workerOptions(QUEUE.OCR))
 * export class OcrProcessor extends TenantProcessor<OcrJob> {
 *   protected readonly schema = OcrJobSchema;
 *   protected handle(job, signal) { … }
 * }
 * ```
 */
export abstract class TenantProcessor<T extends object> extends WorkerHost {
  protected abstract readonly schema: z.ZodType<T>;

  constructor(
    protected readonly tenant: TenantRunner,
    protected readonly prisma: PrismaService,
    protected readonly logger: PinoLogger,
  ) {
    super();
  }

  protected abstract handle(job: Job<T & TenantJobData>, signal: AbortSignal): Promise<unknown>;

  /** Registered with the worker as it is created: without a listener a Redis error would crash the worker process. */
  @OnWorkerEvent('error')
  onWorkerError(error: Error): void {
    this.logger.error({ err: error }, 'Worker connection error');
  }

  async process(job: Job<T & TenantJobData>): Promise<unknown> {
    const tenant = parseTenantJob(job.data);
    if (!tenant || !this.schema.safeParse(job.data).success) {
      this.logger.error(
        jobLogFields(job, tenant?.requestId ?? null),
        'Invalid job payload; not retried',
      );
      throw new UnrecoverableError('Invalid job payload');
    }
    const policy = QUEUE_POLICY[job.queueName as QueueName];
    if (!policy) throw new UnrecoverableError(`No queue policy for ${job.queueName}`);
    const fields = jobLogFields(job, tenant.requestId);
    try {
      return await this.tenant.run(
        { officeId: tenant.officeId, ...(tenant.requestId ? { requestId: tenant.requestId } : {}) },
        async () => {
          const office = await this.prisma.db.office.findFirst({ select: { isActive: true } });
          if (!office?.isActive) {
            this.logger.warn(fields, 'Office is inactive; job skipped');
            return SKIPPED_OFFICE_INACTIVE;
          }
          return withTimeout((signal) => this.handle(job, signal), policy.timeoutMs);
        },
      );
    } catch (error) {
      this.logger.warn({ ...fields, err: error }, 'Job attempt failed');
      throw error;
    }
  }
}
