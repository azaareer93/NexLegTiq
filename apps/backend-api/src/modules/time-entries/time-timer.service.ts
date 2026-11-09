import { Injectable } from '@nestjs/common';
import type {
  StartTimerRequest,
  StopTimerRequest,
  TimeEntry,
  Timer,
} from '@nexlegtiq/shared-contracts';
import { wallClock } from '@nexlegtiq/shared-utils';
import { ClsService } from 'nestjs-cls';

import { FILE, TimeEntriesService } from './time-entries.service';
import { AuditService } from '../../common/audit/audit.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  ResourceConflictException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { isPrismaError } from '../../common/errors/prisma-error';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import { Prisma } from '../../generated/prisma/client';
import { CaseAccessService } from '../legal-files/case-access.service';
import { toDbDate } from '../tasks/tasks.repository';

const MAX_MINUTES = 24 * 60;

/**
 * The minutes a timer that ran `elapsedMs` is billed for: rounded up to the office's increment, at least one increment,
 * at most a day (D-152). Hours are minutes / 60 at two decimals.
 */
export function roundedHours(elapsedMs: number, incrementMinutes: number): Prisma.Decimal {
  const minutes = Math.ceil(Math.max(elapsedMs, 1) / 60_000 / incrementMinutes) * incrementMinutes;
  return new Prisma.Decimal(Math.min(minutes, MAX_MINUTES)).div(60).toDecimalPlaces(2);
}

/** The running timer (MVP-90, D-152): one per user; stopping it logs a time entry. */
@Injectable()
export class TimerService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly uow: UnitOfWork,
    private readonly files: CaseAccessService,
    private readonly audit: AuditService,
    private readonly entries: TimeEntriesService,
  ) {}

  private caller() {
    return this.entries.caller();
  }

  private get terms() {
    return this.entries.terms.bind(this.entries);
  }

  private get(id: string): Promise<TimeEntry> {
    return this.entries.get(id);
  }

  async timer(): Promise<Timer | null> {
    const { userId } = this.caller();
    const row = await this.prisma.db.timeTimer.findFirst({
      where: { userId },
      select: { id: true, description: true, startedAt: true, file: FILE },
    });
    return row ? { ...row, startedAt: row.startedAt.toISOString() } : null;
  }

  async start(input: StartTimerRequest): Promise<Timer> {
    const { userId } = this.caller();
    await this.files.assertFileAccess(input.fileId, 'contribute');
    try {
      await this.prisma.db.timeTimer.create({
        data: {
          officeId: this.cls.get('officeId') as string,
          userId,
          fileId: input.fileId,
          description: input.description || null,
        },
      });
    } catch (error) {
      // One running timer per user (unique index): stop the running one first.
      if (isPrismaError(error) && error.code === 'P2002') {
        throw new ResourceConflictException('RES-002', 'A timer is already running');
      }
      throw error;
    }
    return (await this.timer()) as Timer;
  }

  /** Stops the caller's timer and records its time, rounded up to the office's increment (D-152). */
  async stop(input: StopTimerRequest, now = new Date()): Promise<TimeEntry> {
    const { userId } = this.caller();
    const timer = await this.prisma.db.timeTimer.findFirst({ where: { userId } });
    if (!timer) throw new ResourceNotFoundException();
    const description = input.description ?? timer.description;
    if (!description) {
      throw new ValidationException([{ field: 'description', message: 'validation.required' }]);
    }
    await this.files.assertFileAccess(timer.fileId, 'contribute');
    const { hourlyRate, currency, increment } = await this.terms(timer.fileId);
    const { timezone } = await this.prisma.db.office.findFirstOrThrow({
      select: { timezone: true },
    });
    const durationHours = roundedHours(now.getTime() - timer.startedAt.getTime(), increment);
    const workDate = wallClock(timer.startedAt, timezone).date;
    const id = await this.uow.run(async (tx) => {
      // Conditional: a second stop racing this one finds nothing to delete.
      const { count } = await tx.timeTimer.deleteMany({ where: { id: timer.id } });
      if (count === 0) throw new ResourceNotFoundException();
      const row = await tx.timeEntry.create({
        data: {
          officeId: timer.officeId,
          fileId: timer.fileId,
          userId,
          workDate: toDbDate(workDate),
          durationHours,
          description,
          isBillable: input.isBillable ?? true,
          hourlyRate,
          currency,
        },
        select: { id: true },
      });
      await this.audit.log(tx, {
        entityType: 'TimeEntry',
        entityId: row.id,
        action: 'CREATE',
        newValues: {
          fileId: timer.fileId,
          workDate,
          durationHours: durationHours.toFixed(2),
          timer: true,
        },
      });
      return row.id;
    });
    return this.get(id);
  }
}
