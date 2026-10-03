import { getQueueToken } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Job, JobsOptions, Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../context/request-context';
import { TenantContextMissingError } from '../tenancy/tenant.errors';
import type { QueueName } from './queues';
import type { JobFields, TenantJobData } from './tenant-job';

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

  async enqueue<T extends JobFields>(queue: QueueName, name: string, data: T, options?: JobsOptions): Promise<Job<T & TenantJobData>> {
    const officeId = this.cls.isActive() ? this.cls.get('officeId') : undefined;
    if (!officeId) throw new TenantContextMissingError(`enqueue ${queue}/${name}`);
    const payload = { ...data, officeId, requestId: this.cls.getId() ?? null } as T & TenantJobData;
    return this.queue(queue).add(name, payload, options) as Promise<Job<T & TenantJobData>>;
  }

  private queue(name: QueueName): Queue {
    return this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
  }
}
