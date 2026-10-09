import { Injectable } from '@nestjs/common';
import type {
  Case,
  CaseListItem,
  CaseQuery,
  CreateCaseRequest,
  UpdateCaseRequest,
} from '@nexlegtiq/shared-contracts';
import type { BillingMethod, Jurisdiction, Permission, UserId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { CaseAccessService } from './case-access.service';
import { CasesRepository } from './cases.repository';
import { FileNumberService } from './file-number.service';
import type { RequestContext } from '../../common/context/request-context';
import {
  PermissionDeniedException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { assignedFilesWhere } from '../../common/rbac/case-scope';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { truncateUserAgent } from '../auth/client-info';

const LAWYER_ROLES = ['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER'] as const;

/** The office's calendar date in its time zone (D-092): a file opened at 01:00 in Hebron is opened that day. */
function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Legal files API (MVP-57, W6/W7/W8, D-096). */
@Injectable()
export class CasesService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly uow: UnitOfWork,
    private readonly access: CaseAccessService,
    private readonly numbers: FileNumberService,
    private readonly cases: CasesRepository,
  ) {}

  /** Opens a file: number, client links, team, FILE_OPENED timeline event and audit row in one transaction. */
  async create(input: CreateCaseRequest, client: ClientInfo): Promise<Case> {
    const actorId = this.actorId();
    this.assertMayEditBilling(input);
    if (input.isConfidential) this.assertMayChangeConfidentiality(input.responsibleLawyerId);
    const id = await this.uow.run(async (tx) => {
      const [office, settings] = await Promise.all([
        tx.office.findFirstOrThrow({
          select: { currency: true, jurisdiction: true, timezone: true },
        }),
        tx.officeSettings.findFirstOrThrow({
          select: { defaultBillingMethod: true, defaultBillingRate: true },
        }),
      ]);
      await assertParticipants(tx, input);
      const openingDate = todayIn(office.timezone, new Date());
      const fileNumber = await this.numbers.next(
        tx,
        input.fileType,
        Number(openingDate.slice(0, 4)),
      );
      const file = await tx.legalFile.create({
        data: {
          ...fileColumns(input, office, settings),
          officeId: this.officeId(),
          fileNumber,
          openingDate: new Date(`${openingDate}T00:00:00Z`),
        },
        select: { id: true },
      });
      await this.addParticipants(tx, file.id, input);
      await tx.caseTimelineEvent.create({
        data: {
          officeId: this.officeId(),
          fileId: file.id,
          eventType: 'FILE_OPENED',
          actorId,
          payload: { fileNumber },
        },
      });
      await tx.auditLog.create({
        data: this.audit(client, file.id, 'CREATE', null, {
          fileNumber,
          title: input.title,
          fileType: input.fileType,
        }),
      });
      return file.id;
    });
    // The creator may not be assigned (a paralegal opening a file for a lawyer): they still get what they sent.
    return this.present(await this.cases.get(id));
  }

  async list(query: CaseQuery): Promise<PaginatedResult<CaseListItem>> {
    const visible = this.access.visibleWhere();
    const access =
      query.scope === 'mine' ? { AND: [visible, assignedFilesWhere(this.actorId())] } : visible;
    const { items, total } = await this.cases.list(access, query);
    return PaginatedResult.of(items, { page: query.page, limit: query.limit, total });
  }

  async get(id: string): Promise<Case> {
    await this.access.assertFileAccess(id, 'read');
    return this.present(await this.cases.get(id));
  }

  /** Edits the file; only fields whose value changes are written and audited (old and new values). */
  async update(id: string, input: UpdateCaseRequest, client: ClientInfo): Promise<Case> {
    await this.access.assertFileAccess(id, 'write');
    this.assertMayEditBilling(input);
    await this.uow.run(async (tx) => {
      const before = await tx.legalFile.findFirst({ where: liveFile(id), select: EDITABLE });
      if (!before) throw new ResourceNotFoundException();
      const { old, next } = changes(before, {
        ...input,
        description: emptyToNull(input.description),
      });
      if (Object.keys(next).length === 0) return;
      if ('isConfidential' in next) this.assertMayChangeConfidentiality(before.responsibleLawyerId);
      await writeLive(tx, id, next);
      await tx.auditLog.create({ data: this.audit(client, id, 'UPDATE', old, next) });
    });
    return this.present(await this.cases.get(id));
  }

  /**
   * Soft delete (`delete:case`): the file disappears from every list; its number is never reused (D-095). Access is
   * checked as a write: every `delete:case` holder (OM, SL) also holds `edit:any:case`.
   */
  async remove(id: string, client: ClientInfo): Promise<void> {
    await this.access.assertFileAccess(id, 'write');
    await this.uow.run(async (tx) => {
      await writeLive(tx, id, { deletedAt: new Date() });
      await tx.auditLog.create({ data: this.audit(client, id, 'DELETE', null, null) });
    });
  }

  /** Billing terms are written only with `generate:invoice` (D-096): not by paralegals, trainees or collaborators. */
  private assertMayEditBilling(input: Partial<Record<(typeof BILLING_FIELDS)[number], unknown>>) {
    const touches = BILLING_FIELDS.some((field) => input[field] !== undefined);
    if (touches && !this.permissions().includes('generate:invoice')) {
      throw new PermissionDeniedException();
    }
  }

  /** Only the office manager or the file's responsible lawyer may make a file confidential or lift it (D-096). */
  private assertMayChangeConfidentiality(responsibleLawyerId: string) {
    if (this.cls.get('role') !== 'OFFICE_MANAGER' && this.actorId() !== responsibleLawyerId) {
      throw new PermissionDeniedException();
    }
  }

  /** Hides the billing terms from a caller without an invoice permission (D-096). */
  private present(file: Case): Case {
    const canSee = this.permissions().some(
      (permission) => permission === 'view:all:invoices' || permission === 'view:assigned:invoices',
    );
    return canSee
      ? file
      : { ...file, billingMethod: null, hourlyRate: null, fixedFee: null, retainerBalance: null };
  }

  private permissions(): readonly Permission[] {
    return this.cls.get('permissions') ?? [];
  }

  private async addParticipants(tx: ScopedTransaction, fileId: string, input: CreateCaseRequest) {
    const officeId = this.officeId();
    await tx.fileClient.createMany({
      data: input.clientIds.map((clientId) => ({
        officeId,
        fileId,
        clientId,
        isPrimary: clientId === input.primaryClientId,
      })),
    });
    await tx.fileTeamMember.createMany({
      data: [
        {
          officeId,
          fileId,
          userId: input.responsibleLawyerId,
          role: 'RESPONSIBLE_LAWYER' as const,
        },
        ...(input.responsibleParalegalId
          ? [{ officeId, fileId, userId: input.responsibleParalegalId, role: 'PARALEGAL' as const }]
          : []),
      ],
    });
  }

  private audit(
    client: ClientInfo,
    entityId: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    oldValues: object | null,
    newValues: object | null,
  ) {
    return {
      officeId: this.officeId(),
      userId: this.actorId(),
      entityType: 'LegalFile',
      entityId,
      action,
      ...(oldValues && { oldValues: JSON.parse(JSON.stringify(oldValues)) as object }),
      ...(newValues && { newValues: JSON.parse(JSON.stringify(newValues)) as object }),
      ipAddress: client.ip,
      userAgent: truncateUserAgent(client.userAgent),
      requestId: client.requestId,
    };
  }

  // A missing caller is a programming error (guarded routes always set it): 500 SYS-001, never a 403 that hides it.
  private actorId(): UserId {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the request context');
    return userId;
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the request context');
    return officeId;
  }
}

const BILLING_FIELDS = ['billingMethod', 'hourlyRate', 'fixedFee'] as const;

/** The columns PATCH may change (UpdateCaseSchema), plus the responsible lawyer for the confidentiality rule. */
const EDITABLE = {
  title: true,
  description: true,
  subType: true,
  priority: true,
  billingMethod: true,
  hourlyRate: true,
  fixedFee: true,
  courtCaseNumber: true,
  isConfidential: true,
  responsibleLawyerId: true,
} satisfies Prisma.LegalFileSelect;

/** Writes may only reach a live, non-archived file, also when it was deleted or archived after the access check. */
const liveFile = (id: string) => ({ id, deletedAt: null, status: { not: 'ARCHIVED' as const } });

async function writeLive(
  tx: ScopedTransaction,
  id: string,
  data: Prisma.LegalFileUpdateManyMutationInput,
) {
  const { count } = await tx.legalFile.updateMany({ where: liveFile(id), data });
  if (count === 0) throw new ResourceNotFoundException();
}

/** The fields of `data` whose value differs from `before`; money compares as decimals and is audited with 2 digits. */
function changes(before: Record<string, unknown>, data: Record<string, unknown>) {
  const old: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const previous = before[key];
    const decimal = Prisma.Decimal.isDecimal(previous) ? previous : null;
    const same = decimal ? value !== null && decimal.equals(value as string) : previous === value;
    if (!same) {
      old[key] = decimal ? decimal.toFixed(2) : previous;
      next[key] = value;
    }
  }
  return { old, next };
}

const orNull = <T>(value: T | undefined): T | null => value ?? null;

/** The columns of a new file that come from the request and the office's defaults. */
function fileColumns(
  input: CreateCaseRequest,
  office: { currency: string; jurisdiction: Jurisdiction },
  settings: { defaultBillingMethod: BillingMethod; defaultBillingRate: Prisma.Decimal | null },
) {
  const billingMethod = input.billingMethod ?? settings.defaultBillingMethod;
  const defaultRate = billingMethod === 'HOURLY' ? settings.defaultBillingRate?.toFixed(2) : null;
  return {
    title: input.title,
    description: input.description || null,
    fileType: input.fileType,
    subType: orNull(input.subType),
    priority: input.priority,
    responsibleLawyerId: input.responsibleLawyerId,
    responsibleParalegalId: orNull(input.responsibleParalegalId),
    courtCaseNumber: orNull(input.courtCaseNumber),
    jurisdiction: office.jurisdiction,
    billingMethod,
    hourlyRate: input.hourlyRate ?? defaultRate ?? null,
    fixedFee: orNull(input.fixedFee),
    currency: office.currency,
    isConfidential: input.isConfidential,
  };
}

const emptyToNull = (value: string | null | undefined) => (value === '' ? null : value);

/** Clients must be live clients of the office; the lawyer and paralegal active users of the right role. */
async function assertParticipants(tx: ScopedTransaction, input: CreateCaseRequest): Promise<void> {
  const [clients, lawyer, paralegal] = await Promise.all([
    tx.client.count({ where: { id: { in: input.clientIds }, deletedAt: null, isActive: true } }),
    tx.user.count({
      where: { id: input.responsibleLawyerId, isActive: true, role: { in: [...LAWYER_ROLES] } },
    }),
    input.responsibleParalegalId
      ? tx.user.count({
          where: { id: input.responsibleParalegalId, isActive: true, role: 'PARALEGAL' },
        })
      : Promise.resolve(1),
  ]);
  const details = [
    ...(clients === input.clientIds.length
      ? []
      : [{ field: 'clientIds', message: 'validation.unknownClient' }]),
    ...(lawyer === 1
      ? []
      : [{ field: 'responsibleLawyerId', message: 'validation.responsibleLawyer' }]),
    ...(paralegal === 1
      ? []
      : [{ field: 'responsibleParalegalId', message: 'validation.responsibleParalegal' }]),
  ];
  if (details.length > 0) throw new ValidationException(details);
}
