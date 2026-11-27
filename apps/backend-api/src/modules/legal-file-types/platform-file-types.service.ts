import { Injectable } from '@nestjs/common';
import type {
  AdminFileType,
  AdminFileTypeQuery,
  CreateFileSubTypeRequest,
  CreateFileTypeRequest,
  UpdateFileSubTypeRequest,
  UpdateFileTypeRequest,
} from '@nexlegtiq/shared-contracts';

import { ORDER } from './legal-file-types.service';
import { changes } from '../../common/audit/changes';
import type { ClientInfo } from '../../common/context/client-info';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import type { LegalFileSubType, LegalFileType } from '../../generated/prisma/client';
import type { Prisma } from '../../generated/prisma/client';
import { PlatformAuditService } from '../platform-auth/platform-audit.service';

type Tx = Prisma.TransactionClient;

const WITH_SUB_TYPES = { subTypes: { orderBy: ORDER } } as const;

/** The editable fields, as audited. */
const snapshot = (row: LegalFileType | LegalFileSubType) => ({
  nameAr: row.nameAr,
  nameEn: row.nameEn,
  sortOrder: row.sortOrder,
  isActive: row.isActive,
});

const toDto = (row: LegalFileType & { subTypes: LegalFileSubType[] }): AdminFileType => ({
  id: row.id,
  jurisdiction: row.jurisdiction,
  code: row.code,
  numberCode: row.numberCode,
  ...snapshot(row),
  subTypes: row.subTypes.map((sub) => ({
    id: sub.id,
    ...snapshot(sub),
    updatedAt: sub.updatedAt.toISOString(),
  })),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * File types and sub-types per country for the platform admin (MVP-175, D-261). Never deleted — files keep them —
 * only deactivated; every change audited. Duplicate codes or names are 409 RES-002 (unique indexes).
 * unscoped: global reference data only the platform admin writes (D-080).
 */
@Injectable()
export class PlatformFileTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
  ) {}

  async list(query: AdminFileTypeQuery): Promise<AdminFileType[]> {
    // unscoped: see the class comment.
    const rows = await this.prisma.unscoped().legalFileType.findMany({
      where: { jurisdiction: query.jurisdiction },
      orderBy: ORDER,
      include: WITH_SUB_TYPES,
    });
    return rows.map(toDto);
  }

  async create(body: CreateFileTypeRequest, adminId: string, client: ClientInfo) {
    return this.write(adminId, client, async (tx) => {
      const created = await tx.legalFileType.create({ data: body });
      const log = { action: 'FILE_TYPE_CREATED', entityId: created.id, oldValues: undefined };
      return { typeId: created.id, ...log, newValues: { ...body } };
    });
  }

  async update(id: string, body: UpdateFileTypeRequest, adminId: string, client: ClientInfo) {
    return this.write(adminId, client, async (tx) => {
      const before = await tx.legalFileType.findUnique({ where: { id } });
      if (!before) throw new ResourceNotFoundException();
      const { old, next } = changes(snapshot(before), body);
      if (Object.keys(next).length > 0)
        await tx.legalFileType.update({ where: { id }, data: next });
      return {
        typeId: id,
        action: 'FILE_TYPE_UPDATED',
        entityId: id,
        oldValues: old,
        newValues: next,
      };
    });
  }

  async createSubType(
    typeId: string,
    body: CreateFileSubTypeRequest,
    adminId: string,
    client: ClientInfo,
  ) {
    return this.write(adminId, client, async (tx) => {
      const type = await tx.legalFileType.findUnique({ where: { id: typeId } });
      if (!type) throw new ResourceNotFoundException();
      const created = await tx.legalFileSubType.create({
        data: { ...body, jurisdiction: type.jurisdiction, typeCode: type.code },
      });
      const newValues = {
        ...snapshot(created),
        jurisdiction: type.jurisdiction,
        typeCode: type.code,
      };
      return { typeId, action: 'FILE_SUB_TYPE_CREATED', entityId: created.id, newValues };
    });
  }

  async updateSubType(
    id: string,
    body: UpdateFileSubTypeRequest,
    adminId: string,
    client: ClientInfo,
  ) {
    return this.write(adminId, client, async (tx) => {
      const before = await tx.legalFileSubType.findUnique({
        where: { id },
        include: { type: true },
      });
      if (!before) throw new ResourceNotFoundException();
      const { old, next } = changes(snapshot(before), body);
      if (Object.keys(next).length > 0)
        await tx.legalFileSubType.update({ where: { id }, data: next });
      // Files are found by their sub-type's names (search trigger, D-165): re-index them after a rename, in every
      // office. Touching the column fires the trigger without changing the row's updatedAt.
      if ('nameAr' in next || 'nameEn' in next) {
        await tx.$executeRaw`UPDATE legal_files SET sub_type_id = sub_type_id WHERE sub_type_id = ${id}::uuid`;
      }
      return {
        typeId: before.type.id,
        action: 'FILE_SUB_TYPE_UPDATED',
        entityId: id,
        oldValues: old,
        newValues: next,
      };
    });
  }

  /** One transaction: the change, its audit row (skipped when nothing changed) and the type as it now is. */
  private async write(
    adminId: string,
    client: ClientInfo,
    change: (tx: Tx) => Promise<{
      typeId: string;
      action: string;
      entityId: string;
      oldValues?: Record<string, unknown>;
      newValues: Record<string, unknown>;
    }>,
  ): Promise<AdminFileType> {
    // unscoped: global reference data only the platform admin writes (D-080).
    return this.prisma.unscoped().$transaction(async (tx) => {
      const { typeId, action, entityId, oldValues, newValues } = await change(tx);
      if (Object.keys(newValues).length > 0) {
        const entityType = action.startsWith('FILE_SUB_TYPE')
          ? 'LegalFileSubType'
          : 'LegalFileType';
        // Names, order and flags only: plain JSON values.
        const json = (values?: Record<string, unknown>) =>
          values as Prisma.InputJsonObject | undefined;
        await this.audit.log(
          {
            adminId,
            action,
            entityType,
            entityId,
            oldValues: json(oldValues),
            newValues: json(newValues),
          },
          client,
          tx,
        );
      }
      return toDto(
        await tx.legalFileType.findUniqueOrThrow({
          where: { id: typeId },
          include: WITH_SUB_TYPES,
        }),
      );
    });
  }
}
