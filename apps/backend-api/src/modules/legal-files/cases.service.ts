import { Injectable } from '@nestjs/common';
import type {
  Case,
  CaseListItem,
  CaseQuery,
  CreateCaseRequest,
  UpdateCaseRequest,
} from '@nexlegtiq/shared-contracts';
import type { BillingMethod, Jurisdiction, UserId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import { CaseAccessService } from './case-access.service';
import { CasesRepository } from './cases.repository';
import { FileNumberService } from './file-number.service';
import type { RequestContext } from '../../common/context/request-context';
import { PermissionDeniedException, ValidationException } from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { assignedFilesWhere } from '../../common/rbac/case-scope';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { Prisma } from '../../generated/prisma/client';
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
    return this.cases.get(id);
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
    return this.cases.get(id);
  }

  async update(id: string, input: UpdateCaseRequest, client: ClientInfo): Promise<Case> {
    await this.access.assertFileAccess(id, 'write');
    await this.uow.run(async (tx) => {
      const before = await tx.legalFile.findFirstOrThrow({
        where: { id },
        select: Object.fromEntries(Object.keys(input).map((key) => [key, true])),
      });
      await tx.legalFile.update({
        where: { id },
        data: { ...input, description: emptyToNull(input.description) },
      });
      await tx.auditLog.create({ data: this.audit(client, id, 'UPDATE', before, input) });
    });
    return this.cases.get(id);
  }

  /** Soft delete (`delete:case`): the file disappears from every list; its number is never reused (D-095). */
  async remove(id: string, client: ClientInfo): Promise<void> {
    await this.access.assertFileAccess(id, 'write');
    await this.uow.run(async (tx) => {
      await tx.legalFile.update({ where: { id }, data: { deletedAt: new Date() } });
      await tx.auditLog.create({ data: this.audit(client, id, 'DELETE', null, null) });
    });
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

  private actorId(): UserId {
    const userId = this.cls.get('userId');
    if (!userId) throw new PermissionDeniedException();
    return userId;
  }

  private officeId(): string {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new PermissionDeniedException();
    return officeId;
  }
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
