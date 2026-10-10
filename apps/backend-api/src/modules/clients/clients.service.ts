import { Injectable } from '@nestjs/common';
import type {
  Client,
  ClientListItem,
  ClientQuery,
  CreateClientRequest,
  UpdateClientRequest,
} from '@nexlegtiq/shared-contracts';

import { ClientContext, changedFields } from './client-context';
import { ClientsRepository, OPEN_FILE_STATUSES, toContact, toListItem } from './clients.repository';
import type { ClientRow } from './clients.repository';
import { FieldCipher } from '../../common/crypto/field-cipher';
import {
  BusinessRuleException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { PaginatedResult } from '../../common/http/paginated-result';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';

const LAWYER_ROLES = ['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER'] as const;
const ENCRYPTED = { nationalId: 'clients.national_id', taxId: 'clients.tax_id' } as const;
type EncryptedField = keyof typeof ENCRYPTED;

/** Clients API (MVP-53, D-108): CRUD, soft delete blocked by open files, encrypted ids, audit. */
@Injectable()
export class ClientsService {
  constructor(
    private readonly ctx: ClientContext,
    private readonly uow: UnitOfWork,
    private readonly cipher: FieldCipher,
    private readonly clients: ClientsRepository,
  ) {}

  async create(input: CreateClientRequest, caller: ClientInfo): Promise<Client> {
    const id = await this.uow.run(async (tx) => {
      if (input.primaryLawyerId) await assertLawyer(tx, input.primaryLawyerId);
      const client = await tx.client.create({
        data: {
          ...input,
          officeId: this.ctx.officeId(),
          nationalId: this.seal('nationalId', input.nationalId),
          taxId: this.seal('taxId', input.taxId),
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: this.ctx.auditRow(caller, 'Client', client.id, 'CREATE', null, { ...input }),
      });
      return client.id;
    });
    return this.get(id);
  }

  async list(query: ClientQuery): Promise<PaginatedResult<ClientListItem>> {
    const { items, total } = await this.clients.list(this.ctx.officeId(), query);
    return PaginatedResult.of(items, { page: query.page, limit: query.limit, total });
  }

  async get(id: string): Promise<Client> {
    const row = await this.clients.get(id);
    if (!row) throw new ResourceNotFoundException();
    return this.present(row);
  }

  /** Writes and audits only the fields whose value changes; encrypted ids are compared decrypted. */
  async update(id: string, input: UpdateClientRequest, caller: ClientInfo): Promise<Client> {
    await this.uow.run(async (tx) => {
      await this.ctx.lockClient(tx, id);
      const before = await tx.client.findFirstOrThrow({ where: { id }, select: EDITABLE });
      const { old, next } = changedFields(
        {
          ...before,
          nationalId: this.open('nationalId', before.nationalId),
          taxId: this.open('taxId', before.taxId),
        },
        input,
      );
      if (Object.keys(next).length === 0) return;
      if (typeof next['primaryLawyerId'] === 'string')
        await assertLawyer(tx, next['primaryLawyerId']);
      await tx.client.updateMany({
        where: { id },
        data: {
          ...next,
          ...('nationalId' in next && { nationalId: this.seal('nationalId', input.nationalId) }),
          ...('taxId' in next && { taxId: this.seal('taxId', input.taxId) }),
        },
      });
      await tx.auditLog.create({
        data: this.ctx.auditRow(caller, 'Client', id, 'UPDATE', old, next),
      });
    });
    return this.get(id);
  }

  /**
   * Soft delete: gone from lists and lookups, kept for the files and invoices that name it. Refused with BIZ-010 while
   * the client has an OPEN or SUSPENDED file (closed files keep pointing at it).
   * ponytail: a file opened for this client in the same instant can still link it (file creation does not lock the
   * client row); lock it there too if that ever shows up.
   */
  async remove(id: string, caller: ClientInfo): Promise<void> {
    await this.uow.run(async (tx) => {
      await this.ctx.lockClient(tx, id);
      const openFiles = await tx.fileClient.count({
        where: { clientId: id, file: { deletedAt: null, status: { in: [...OPEN_FILE_STATUSES] } } },
      });
      if (openFiles > 0) {
        throw new BusinessRuleException('BIZ-010', 'The client has open files');
      }
      await tx.client.updateMany({ where: { id }, data: { deletedAt: new Date() } });
      await tx.auditLog.create({
        data: this.ctx.auditRow(caller, 'Client', id, 'DELETE', null, null),
      });
    });
  }

  private present(row: ClientRow): Client {
    return {
      ...toListItem(row, row.openFiles),
      nationalId: this.open('nationalId', row.nationalId),
      taxId: this.open('taxId', row.taxId),
      address: row.address,
      industry: row.industry,
      closedFiles: row.closedFiles,
      contacts: row.contacts.map(toContact),
    };
  }

  private seal(field: EncryptedField, value: string | null | undefined): string | null {
    return value ? this.cipher.encrypt(value, `${ENCRYPTED[field]}:${this.ctx.officeId()}`) : null;
  }

  private open(field: EncryptedField, value: string | null): string | null {
    return value && this.cipher.decrypt(value, `${ENCRYPTED[field]}:${this.ctx.officeId()}`);
  }
}

/** The columns PATCH may change (UpdateClientSchema). */
const EDITABLE = {
  clientType: true,
  displayName: true,
  fullName: true,
  companyName: true,
  nationalId: true,
  taxId: true,
  phone: true,
  email: true,
  address: true,
  industry: true,
  primaryLawyerId: true,
  isActive: true,
} as const;

/** The primary lawyer must be an active lawyer of the office (else 400 VAL-001 on the field). */
async function assertLawyer(tx: ScopedTransaction, userId: string): Promise<void> {
  const lawyers = await tx.user.count({
    where: { id: userId, isActive: true, role: { in: [...LAWYER_ROLES] } },
  });
  if (lawyers !== 1) {
    throw new ValidationException([
      { field: 'primaryLawyerId', message: 'validation.primaryLawyer' },
    ]);
  }
}
