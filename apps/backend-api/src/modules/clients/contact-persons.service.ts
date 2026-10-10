import { Injectable } from '@nestjs/common';
import type {
  ContactPerson,
  CreateContactPersonRequest,
  UpdateContactPersonRequest,
} from '@nexlegtiq/shared-contracts';

import { ClientContext, changedFields } from './client-context';
import { CONTACT_SELECT, toContact } from './clients.repository';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { UnitOfWork } from '../../database/unit-of-work';
import type { ScopedTransaction } from '../../database/unit-of-work';
import type { ClientInfo } from '../auth/client-info';

const ORDER = [{ isPrimary: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] as const;

/**
 * Contact persons of a client (MVP-53, D-108). A client with contacts has exactly one primary: the first contact is
 * primary, promoting one demotes the other, deleting the primary promotes the oldest remaining contact. Every write
 * locks the client row, so concurrent writes on one client queue instead of breaking that rule.
 */
@Injectable()
export class ContactPersonsService {
  constructor(
    private readonly ctx: ClientContext,
    private readonly uow: UnitOfWork,
    private readonly prisma: PrismaService,
  ) {}

  async list(clientId: string): Promise<ContactPerson[]> {
    const client = await this.prisma.db.client.findFirst({
      where: { id: clientId, deletedAt: null },
      select: { contacts: { orderBy: [...ORDER], select: CONTACT_SELECT } },
    });
    if (!client) throw new ResourceNotFoundException();
    return client.contacts.map(toContact);
  }

  async create(
    clientId: string,
    input: CreateContactPersonRequest,
    caller: ClientInfo,
  ): Promise<ContactPerson> {
    return this.uow.run(async (tx) => {
      await this.ctx.lockClient(tx, clientId);
      const isPrimary =
        input.isPrimary || (await tx.contactPerson.count({ where: { clientId } })) === 0;
      if (isPrimary) await demotePrimary(tx, clientId);
      const contact = await tx.contactPerson.create({
        data: { ...input, isPrimary, clientId, officeId: this.ctx.officeId() },
        select: CONTACT_SELECT,
      });
      await tx.auditLog.create({
        data: this.ctx.auditRow(caller, 'ContactPerson', contact.id, 'CREATE', null, {
          clientId,
          ...input,
          isPrimary,
        }),
      });
      return toContact(contact);
    });
  }

  async update(
    clientId: string,
    id: string,
    input: UpdateContactPersonRequest,
    caller: ClientInfo,
  ): Promise<ContactPerson> {
    return this.uow.run(async (tx) => {
      await this.ctx.lockClient(tx, clientId);
      const before = await findContact(tx, clientId, id);
      const { old, next } = changedFields(before, input);
      if (Object.keys(next).length > 0) {
        if (next['isPrimary'] === true) await demotePrimary(tx, clientId);
        await tx.contactPerson.updateMany({ where: { id }, data: next });
        await tx.auditLog.create({
          data: this.ctx.auditRow(caller, 'ContactPerson', id, 'UPDATE', old, next),
        });
      }
      return toContact(await findContact(tx, clientId, id));
    });
  }

  async remove(clientId: string, id: string, caller: ClientInfo): Promise<void> {
    await this.uow.run(async (tx) => {
      await this.ctx.lockClient(tx, clientId);
      const contact = await findContact(tx, clientId, id);
      await tx.contactPerson.deleteMany({ where: { id } });
      if (contact.isPrimary) {
        const next = await tx.contactPerson.findFirst({
          where: { clientId },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true },
        });
        if (next)
          await tx.contactPerson.updateMany({ where: { id: next.id }, data: { isPrimary: true } });
      }
      await tx.auditLog.create({
        data: this.ctx.auditRow(
          caller,
          'ContactPerson',
          id,
          'DELETE',
          { clientId, fullName: contact.fullName },
          null,
        ),
      });
    });
  }
}

async function findContact(tx: ScopedTransaction, clientId: string, id: string) {
  const contact = await tx.contactPerson.findFirst({
    where: { id, clientId },
    select: CONTACT_SELECT,
  });
  if (!contact) throw new ResourceNotFoundException();
  return contact;
}

const demotePrimary = (tx: ScopedTransaction, clientId: string) =>
  tx.contactPerson.updateMany({ where: { clientId, isPrimary: true }, data: { isPrimary: false } });
