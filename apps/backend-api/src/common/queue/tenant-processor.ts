import { WorkerHost } from '@nestjs/bullmq';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import type { PinoLogger } from 'nestjs-pino';

import type { TenantRunner } from '../tenancy/tenant-runner';
import { QUEUE_POLICY } from './queues';
import type { QueueName } from './queues';
import { parseTenantJob } from './tenant-job';
import type { TenantJobData } from './tenant-job';

/** Log fields for one job attempt: worker logs have no HTTP request, so the request id comes from the payload (D-076). */
export function jobLogFields(job: Job, requestId: string | null) {
  return { queue: job.queueName, jobId: job.id, job: job.name, attempt: job.attemptsMade + 1, requestId };
}

/**
 * Base of every processor (D-084): validates the tenant part of the payload, runs `handle` in the job's office through
 * TenantRunner (so the scoped Prisma client works as in a request) and applies the queue's timeout. A payload without a
 * valid `officeId` fails at once without retries. Handlers must be idempotent: a retried job runs again in full.
 *
 * ```ts
 * @Processor(QUEUE.OCR, workerOptions(QUEUE.OCR))
 * export class OcrProcessor extends TenantProcessor<OcrJob> { protected handle(job) { … } }
 * ```
 */
export abstract class TenantProcessor<T extends object> extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    protected readonly tenant: TenantRunner,
    protected readonly logger: PinoLogger,
  ) {
    super();
  }

  protected abstract handle(job: Job<T & TenantJobData>): Promise<unknown>;

  /** Worker connection errors (Redis outage) are logged; without a listener they would crash the worker process. */
  onApplicationBootstrap(): void {
    this.worker.on('error', (error) => this.logger.error({ err: error, queue: this.worker.name }, 'Worker connection error'));
  }

  async process(job: Job<T & TenantJobData>): Promise<unknown> {
    const tenant = parseTenantJob(job.data);
    if (!tenant) {
      this.logger.error(jobLogFields(job, null), 'Job payload has no valid officeId; not retried');
      throw new UnrecoverableError('Job payload has no valid officeId');
    }
    const fields = jobLogFields(job, tenant.requestId);
    try {
      const timeoutMs = QUEUE_POLICY[job.queueName as QueueName]?.timeoutMs ?? 60_000;
      return await this.tenant.run({ officeId: tenant.officeId, ...(tenant.requestId ? { requestId: tenant.requestId } : {}) }, () =>
        withTimeout(this.handle(job), timeoutMs),
      );
    } catch (error) {
      this.logger.warn({ ...fields, err: error }, 'Job attempt failed');
      throw error;
    }
  }
}

/** Rejects after `ms`. The work itself is not cancelled; the attempt is failed so BullMQ retries or gives up. */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Job timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
