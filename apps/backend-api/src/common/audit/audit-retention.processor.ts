import { Processor } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { PrismaService } from '../../database/prisma.service';
import { InvoiceOverdueSweep } from '../../modules/invoices/invoice-overdue.sweep';
import { getQueue, QUEUE, workerOptions } from '../queue/queues';
import type { TenantJobData } from '../queue/tenant-job';
import { TenantProcessor } from '../queue/tenant-processor';
import { TenantRunner } from '../tenancy/tenant-runner';

export const PURGE_AUDIT_LOGS_JOB = 'purge-audit-logs';
/** Daily at 03:00 UTC, an hour after the reminder reconciliation. */
export const MARK_OVERDUE_INVOICES_JOB = 'mark-overdue-invoices';
/** Daily at 04:00 UTC: already past midnight in the markets' zones (Hebron is UTC+2/+3). */
export const OVERDUE_SCHEDULE = { pattern: '0 4 * * *', tz: 'UTC' } as const;
export const PURGE_SCHEDULE = { pattern: '0 3 * * *', tz: 'UTC' } as const;

/**
 * The `report` queue's single consumer for now (BullMQ gives every job of a queue to its workers — report jobs join this
 * processor when they arrive). `purge-audit-logs` (daily scheduler, no office) removes audit rows older than each office's
 * retention (D-060, D-136) through `nlq_purge_audit_logs`, the only DELETE the app role may cause on the log.
 */
@Injectable()
@Processor(QUEUE.REPORT, workerOptions(QUEUE.REPORT))
export class AuditRetentionProcessor
  extends TenantProcessor<Record<string, never>>
  implements OnApplicationBootstrap
{
  protected readonly schema = z.object({});

  constructor(
    tenant: TenantRunner,
    prisma: PrismaService,
    logger: PinoLogger,
    private readonly moduleRef: ModuleRef,
    private readonly overdue: InvoiceOverdueSweep,
  ) {
    super(tenant, prisma, logger);
  }

  /** Registers (or updates) the daily purge; a Redis outage at boot is logged, not fatal. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const queue = getQueue(this.moduleRef, QUEUE.REPORT);
      await queue.upsertJobScheduler(PURGE_AUDIT_LOGS_JOB, PURGE_SCHEDULE, {
        name: PURGE_AUDIT_LOGS_JOB,
        data: {},
      });
      await queue.upsertJobScheduler(MARK_OVERDUE_INVOICES_JOB, OVERDUE_SCHEDULE, {
        name: MARK_OVERDUE_INVOICES_JOB,
        data: {},
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'Report schedulers not registered');
    }
  }

  /** The purge spans every office, so it runs before the tenant checks of `TenantProcessor.process`. */
  override async process(job: Job<Record<string, never> & TenantJobData>): Promise<unknown> {
    if (job.name === PURGE_AUDIT_LOGS_JOB) return this.purge();
    // A platform job: only the scheduler's (no office in its data) may run it, never a job someone queued for an office.
    if (job.name === MARK_OVERDUE_INVOICES_JOB && !('officeId' in (job.data ?? {}))) {
      return this.overdue.run();
    }
    return super.process(job);
  }

  protected handle(job: Job): Promise<unknown> {
    throw new UnrecoverableError(`Unknown report job ${job.name}`);
  }

  /** Every office, active or not: a suspended office's old rows age out too. */
  async purge(): Promise<{ readonly removed: number }> {
    // unscoped: the daily purge covers every office; the function limits each office to its own retention.
    const raw = this.prisma.unscoped();
    const offices = await raw.office.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    let removed = 0;
    // One office per statement (and transaction): a first run over years of rows never holds one huge DELETE.
    for (const { id } of offices) {
      const [row] = await raw.$queryRaw<{ removed: number }[]>`
        SELECT nlq_purge_audit_logs(${id}::uuid) AS removed`;
      removed += row?.removed ?? 0;
    }
    this.logger.info({ removed }, 'Audit log retention applied');
    return { removed };
  }
}
