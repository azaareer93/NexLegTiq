import type { ClsService } from 'nestjs-cls';

import { ClientContext } from './client-context';
import type { ClientRow, ClientsRepository } from './clients.repository';
import { ClientsService } from './clients.service';
import { ContactPersonsService } from './contact-persons.service';
import type { RequestContext } from '../../common/context/request-context';
import { FieldCipher } from '../../common/crypto/field-cipher';
import {
  BusinessRuleException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';
import type { PrismaService } from '../../database/prisma.service';
import type { UnitOfWork } from '../../database/unit-of-work';

const OFFICE = 'office-1';
const CALLER = { ip: '127.0.0.1', userAgent: 'jest', requestId: 'req-12345678' };
const NOW = new Date('2026-10-10T10:00:00Z');
const cipher = new FieldCipher(new AppConfig(parseEnv(testEnv())));
const cls = {
  get: (key: string) => ({ officeId: OFFICE, userId: 'user-1' })[key],
} as unknown as ClsService<RequestContext>;
const ctx = new ClientContext(cls);

const contact = (id: string, isPrimary: boolean) => ({
  id,
  fullName: `Contact ${id}`,
  position: null,
  email: null,
  phone: null,
  isPrimary,
  createdAt: NOW,
  updatedAt: NOW,
});

function txMock() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'c1' }]),
    client: {
      create: jest.fn().mockResolvedValue({ id: 'c1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: jest.fn(),
    },
    user: { count: jest.fn().mockResolvedValue(1) },
    fileClient: { count: jest.fn().mockResolvedValue(0) },
    contactPerson: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(({ data }: { data: { isPrimary: boolean } }) =>
        Promise.resolve(contact('k-new', data.isPrimary)),
      ),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

function setup() {
  const tx = txMock();
  const uow = {
    run: (work: (t: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as UnitOfWork;
  const row = (overrides: Partial<ClientRow> = {}): ClientRow => ({
    id: 'c1',
    clientType: 'INDIVIDUAL',
    displayName: 'Ahmad',
    fullName: null,
    companyName: null,
    phone: null,
    email: null,
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    primaryLawyer: null,
    nationalId: null,
    taxId: null,
    address: null,
    industry: null,
    contacts: [],
    openFiles: 0,
    closedFiles: 0,
    ...overrides,
  });
  const repo = { get: jest.fn().mockResolvedValue(row()), list: jest.fn() };
  const clients = new ClientsService(ctx, uow, cipher, repo as unknown as ClientsRepository);
  const prisma = { db: { client: { findFirst: jest.fn() } } } as unknown as PrismaService;
  const contacts = new ContactPersonsService(ctx, uow, prisma);
  return { tx, repo, row, clients, contacts, prisma };
}

const auditOf = (tx: ReturnType<typeof txMock>, index = 0) =>
  (tx.auditLog.create.mock.calls[index] as [{ data: Record<string, unknown> }])[0].data;

describe('ClientsService', () => {
  it('should encrypt ids bound to the new row and audit them redacted', async () => {
    const { tx, clients } = setup();
    await clients.create(
      { clientType: 'INDIVIDUAL', displayName: 'Ahmad', nationalId: '401234567' },
      CALLER,
    );
    expect(tx.client.create.mock.calls[0]).toEqual([
      {
        data: { clientType: 'INDIVIDUAL', displayName: 'Ahmad', officeId: OFFICE },
        select: { id: true },
      },
    ]);
    const sealed = (tx.client.updateMany.mock.calls[0] as [{ data: { nationalId: string } }])[0]
      .data.nationalId;
    expect(cipher.decrypt(sealed, `clients.national_id:${OFFICE}:c1`)).toBe('401234567');
    expect(() => cipher.decrypt(sealed, `clients.national_id:${OFFICE}:c2`)).toThrow();
    expect(auditOf(tx)).toMatchObject({
      action: 'CREATE',
      newValues: { nationalId: '[encrypted]' },
    });
  });

  it('should not write ids when none are given, and refuse an invalid primary lawyer', async () => {
    const { tx, clients } = setup();
    await clients.create({ clientType: 'NGO', displayName: 'Charity' }, CALLER);
    expect(tx.client.updateMany).not.toHaveBeenCalled();
    tx.user.count.mockResolvedValue(0);
    await expect(
      clients.create({ clientType: 'NGO', displayName: 'X', primaryLawyerId: 'u9' }, CALLER),
    ).rejects.toBeInstanceOf(ValidationException);
  });

  it('should decrypt ids in the detail and answer 404 for a missing client', async () => {
    const { repo, row, clients } = setup();
    repo.get.mockResolvedValueOnce(
      row({ nationalId: cipher.encrypt('401', `clients.national_id:${OFFICE}:c1`) }),
    );
    await expect(clients.get('c1')).resolves.toMatchObject({ nationalId: '401', taxId: null });
    repo.get.mockResolvedValueOnce(null);
    await expect(clients.get('c1')).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('should write nothing when PATCH changes nothing, compare ids decrypted and re-seal changed ones', async () => {
    const { tx, clients } = setup();
    const stored = cipher.encrypt('401', `clients.national_id:${OFFICE}:c1`);
    tx.client.findFirstOrThrow.mockResolvedValue({
      displayName: 'A',
      nationalId: stored,
      taxId: null,
    });
    await clients.update('c1', { displayName: 'A', nationalId: '401' }, CALLER);
    expect(tx.client.updateMany).not.toHaveBeenCalled();

    await clients.update('c1', { nationalId: '402', taxId: null, primaryLawyerId: 'u1' }, CALLER);
    const data = (
      tx.client.updateMany.mock.calls[0] as [{ data: Record<string, string | null> }]
    )[0].data;
    expect(cipher.decrypt(data['nationalId'] as string, `clients.national_id:${OFFICE}:c1`)).toBe(
      '402',
    );
    expect(tx.user.count).toHaveBeenCalled();
    expect(auditOf(tx)).toMatchObject({
      oldValues: { nationalId: '[encrypted]' },
      newValues: { nationalId: '[encrypted]', primaryLawyerId: 'u1' },
    });
  });

  it('should refuse deleting a client with open files (BIZ-010) and audit a deletion by name', async () => {
    const { tx, clients } = setup();
    tx.client.findFirstOrThrow.mockResolvedValue({ displayName: 'Ahmad' });
    tx.fileClient.count.mockResolvedValueOnce(2);
    await expect(clients.remove('c1', CALLER)).rejects.toBeInstanceOf(BusinessRuleException);
    await clients.remove('c1', CALLER);
    expect(auditOf(tx)).toMatchObject({ action: 'DELETE', oldValues: { displayName: 'Ahmad' } });
  });

  it('should answer 404 when the locked client does not exist', async () => {
    const { tx, clients } = setup();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(clients.remove('c1', CALLER)).rejects.toBeInstanceOf(ResourceNotFoundException);
  });
});

describe('ContactPersonsService', () => {
  it('should make the first contact primary and promote a later one on request', async () => {
    const { tx, contacts } = setup();
    tx.contactPerson.findFirst.mockResolvedValue(null);
    await expect(
      contacts.create('c1', { fullName: 'A', isPrimary: false }, CALLER),
    ).resolves.toMatchObject({ isPrimary: true });
    tx.contactPerson.count.mockResolvedValue(1);
    tx.contactPerson.findFirst.mockResolvedValue({ id: 'k-old' });
    await contacts.create('c1', { fullName: 'B', isPrimary: true }, CALLER);
    expect(auditOf(tx, 1)).toMatchObject({ newValues: { previousPrimaryId: 'k-old' } });
    await contacts.create('c1', { fullName: 'C', isPrimary: false }, CALLER);
    expect(auditOf(tx, 2)['newValues']).toMatchObject({ isPrimary: false });
  });

  it('should promote on PATCH, skip unchanged fields and 404 a contact of another client', async () => {
    const { tx, contacts } = setup();
    tx.contactPerson.findFirst
      .mockResolvedValueOnce(contact('k2', false)) // findContact
      .mockResolvedValueOnce({ id: 'k1' }) // current primary
      .mockResolvedValueOnce(contact('k2', true)); // re-read
    await expect(contacts.update('c1', 'k2', { isPrimary: true }, CALLER)).resolves.toMatchObject({
      isPrimary: true,
    });
    expect(auditOf(tx)).toMatchObject({ newValues: { isPrimary: true, previousPrimaryId: 'k1' } });

    tx.contactPerson.findFirst.mockResolvedValue(contact('k2', false));
    await contacts.update('c1', 'k2', { fullName: 'Contact k2' }, CALLER);
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);

    tx.contactPerson.findFirst.mockResolvedValue(null);
    await expect(contacts.update('c1', 'k9', { fullName: 'X' }, CALLER)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });

  it('should promote the oldest contact when the primary is deleted', async () => {
    const { tx, contacts } = setup();
    tx.contactPerson.findFirst
      .mockResolvedValueOnce(contact('k1', true))
      .mockResolvedValueOnce({ id: 'k2' });
    await contacts.remove('c1', 'k1', CALLER);
    expect(tx.contactPerson.updateMany).toHaveBeenCalledWith({
      where: { id: 'k2' },
      data: { isPrimary: true },
    });
    expect(auditOf(tx)).toMatchObject({ oldValues: { promotedContactId: 'k2' } });

    tx.contactPerson.findFirst.mockResolvedValueOnce(contact('k3', false));
    await contacts.remove('c1', 'k3', CALLER);
    expect(tx.contactPerson.updateMany).toHaveBeenCalledTimes(1);
  });

  it('should list contacts of a live client or answer 404', async () => {
    const { prisma, contacts } = setup();
    const findFirst = prisma.db.client.findFirst as unknown as jest.Mock;
    findFirst.mockResolvedValueOnce({ contacts: [contact('k1', true)] });
    await expect(contacts.list('c1')).resolves.toEqual([
      expect.objectContaining({ id: 'k1', createdAt: NOW.toISOString() }),
    ]);
    findFirst.mockResolvedValueOnce(null);
    await expect(contacts.list('c1')).rejects.toBeInstanceOf(ResourceNotFoundException);
  });
});
