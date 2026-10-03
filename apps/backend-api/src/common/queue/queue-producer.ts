import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job, JobsOptions } from 'bullmq';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../context/request-context';
import { TenantContextMissingError } from '../tenancy/tenant.errors';
import { getQueue } from './queues';
import type { QueueName } from './queues';
import type { JobFields, TenantJobData } from './tenant-job';
import { withTimeout } from './with-timeout';

/**
 * What a producer may choose per job. Retry, backoff and retention come from the queue policy only. A `jobId` (for
 * de-duplication or a later cancel) is stored prefixed with the office, so two offices can never collide on one id.
 */
export type EnqueueOptions = Pick<JobsOptions, 'jobId' | 'delay' | 'priority'>;

/**
 * The only way to enqueue a job (D-084). `officeId` and `requestId` come from the current request or TenantRunner
 * context, never from the caller, so a job can only run for the office that enqueued it. Enqueue after the database
 * transaction commits (`UnitOfWork.run(..., afterCommit)`), so workers never see uncommitted rows.
 */
@Injectable()
export class QueueProducer {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  async enqueue<T extends JobFields>(queue: QueueName, name: string, data: T, options: EnqueueOptions = {}): Promise<Job<T & TenantJobData>> {
    const officeId = this.cls.isActive() ? this.cls.get('officeId') : undefined;
    if (!officeId) throw new TenantContextMissingError(`enqueue ${queue}/${name}`);
    // Spread first: a caller that smuggles officeId/requestId past the types is overwritten by the context.
    const payload = { ...data, officeId, requestId: this.cls.getId() } as T & TenantJobData;
    const { jobId, ...rest } = options;
    const add = () =>
      getQueue(this.moduleRef, queue).add(name, payload, {
        ...rest,
        // BullMQ forbids ':' in custom ids.
        ...(jobId ? { jobId: `${officeId}_${jobId}` } : {}),
      });
    // While Redis is down ioredis keeps the command queued and reconnects for minutes; the caller gets an error after
    // ENQUEUE_TIMEOUT_MS instead of a hanging request. The queued command may still run once Redis is back — fine for
    // after-commit enqueues, whose data is already committed. (BullMQ's own setup breaks with enableOfflineQueue: false.)
    return (await withTimeout(add, ENQUEUE_TIMEOUT_MS)) as Job<T & TenantJobData>;
  }
}

export const ENQUEUE_TIMEOUT_MS = 2000;
