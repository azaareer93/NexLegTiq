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
      const previousPrimaryId = isPrimary ? await demotePrimary(tx, clientId) : null;
      const contact = await tx.contactPerson.create({
        data: { ...input, isPrimary, clientId, officeId: this.ctx.officeId() },
        select: CONTACT_SELECT,
      });
      await tx.auditLog.create({
        data: this.ctx.auditRow(caller, 'ContactPerson', contact.id, 'CREATE', null, {
          clientId,
          ...input,
          isPrimary,
          ...(previousPrimaryId && { previousPrimaryId }),
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
        const previousPrimaryId = next['isPrimary'] ? await demotePrimary(tx, clientId) : null;
        await tx.contactPerson.updateMany({ where: { id }, data: next });
        await tx.auditLog.create({
          data: this.ctx.auditRow(caller, 'ContactPerson', id, 'UPDATE', old, {
            ...next,
            ...(previousPrimaryId && { previousPrimaryId }),
          }),
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
      const promoted = contact.isPrimary
        ? await tx.contactPerson.findFirst({
            where: { clientId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true },
          })
        : null;
      if (promoted) {
        await tx.contactPerson.updateMany({
          where: { id: promoted.id },
          data: { isPrimary: true },
        });
      }
      await tx.auditLog.create({
        data: this.ctx.auditRow(
          caller,
          'ContactPerson',
          id,
          'DELETE',
          {
            clientId,
            fullName: contact.fullName,
            isPrimary: contact.isPrimary,
            ...(promoted && { promotedContactId: promoted.id }),
          },
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

/** Demotes the client's primary contact, if any, and returns its id for the audit row. */
async function demotePrimary(tx: ScopedTransaction, clientId: string): Promise<string | null> {
  const current = await tx.contactPerson.findFirst({
    where: { clientId, isPrimary: true },
    select: { id: true },
  });
  if (current) {
    await tx.contactPerson.updateMany({ where: { id: current.id }, data: { isPrimary: false } });
  }
  return current?.id ?? null;
}
