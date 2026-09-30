import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { OfficeId, UserId } from '@nexlegtiq/shared-types';
import { CLS_ID, ClsService } from 'nestjs-cls';

import type { RequestContext } from '../context/request-context';

export interface TenantRunContext {
  readonly officeId: OfficeId;
  readonly userId?: UserId;
  /** Carried from the job payload so worker logs correlate with the request that enqueued it (D-076). */
  readonly requestId?: string;
}

/**
 * Runs work outside an HTTP request (BullMQ jobs, schedulers, scripts) in a tenant context: a fresh CLS context with the
 * given office, so the scoped Prisma client and loggers behave exactly as in a request. Every job payload carries
 * `officeId` and `requestId` (tenant-isolation skill).
 */
@Injectable()
export class TenantRunner {
  constructor(private readonly cls: ClsService<RequestContext>) {}

  run<T>(context: TenantRunContext, work: () => Promise<T>): Promise<T> {
    // override, not the default 'inherit': work for office B started inside office A's request must not keep A's user,
    // role or permissions.
    return this.cls.run({ ifNested: 'override' }, () => {
      this.cls.set(CLS_ID, context.requestId ?? randomUUID());
      this.cls.set('officeId', context.officeId);
      if (context.userId) this.cls.set('userId', context.userId);
      return work();
    });
  }
}
