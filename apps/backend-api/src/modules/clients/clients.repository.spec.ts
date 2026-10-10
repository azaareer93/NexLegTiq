import { ClientQuerySchema } from '@nexlegtiq/shared-contracts';

import { ClientsRepository } from './clients.repository';
import type { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';

const NOW = new Date('2026-10-10T10:00:00Z');
const row = (id: string) => ({
  id,
  clientType: 'INDIVIDUAL',
  displayName: id,
  fullName: null,
  companyName: null,
  phone: null,
  email: null,
  isActive: true,
  createdAt: NOW,
  updatedAt: NOW,
  primaryLawyer: null,
});

function setup() {
  const db = {
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'b', open_files: 2 },
        { id: 'a', open_files: 0 },
        { id: 'gone', open_files: 0 },
      ])
      .mockResolvedValueOnce([{ total: 3 }]),
    client: { findMany: jest.fn().mockResolvedValue([row('a'), row('b')]), findFirst: jest.fn() },
    fileClient: { count: jest.fn().mockResolvedValue(1) },
  };
  return { db, repo: new ClientsRepository({ db } as unknown as PrismaService) };
}

/** The tagged-template call `$queryRaw\`…\`` rebuilt as one SQL text with its parameters. */
const sqlOf = (call: unknown[] | undefined) => {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  const sql = Prisma.sql(strings, ...values);
  return { text: sql.sql.replace(/\s+/g, ' '), values: sql.values };
};

describe('ClientsRepository.list', () => {
  it('should keep the SQL order, skip rows that vanished and pass every value as a parameter', async () => {
    const { db, repo } = setup();
    const query = ClientQuerySchema.parse({
      search: '50%_x',
      clientType: 'INDIVIDUAL',
      isActive: 'true',
      sort: 'openFiles:desc,name',
      page: '2',
      limit: '10',
    });
    const result = await repo.list('office-1', query);
    expect(result).toEqual({
      items: [
        expect.objectContaining({ id: 'b', openFiles: 2, createdAt: NOW.toISOString() }),
        expect.objectContaining({ id: 'a', openFiles: 0 }),
      ],
      total: 3,
    });
    const page = sqlOf(db.$queryRaw.mock.calls[0]);
    expect(page.text).toContain('ORDER BY open_files DESC, c.display_name ASC, c.id ASC');
    expect(page.values).toEqual(
      expect.arrayContaining(['office-1', 'INDIVIDUAL', true, '%50\\%\\_x%', 10, 10]),
    );
    expect(page.text).not.toContain('50%');
  });

  it('should list without filters and count files by status', async () => {
    const { db, repo } = setup();
    await repo.list('office-1', ClientQuerySchema.parse({ sort: 'createdAt:desc' }));
    const page = sqlOf(db.$queryRaw.mock.calls[0]);
    expect(page.text).toContain('ORDER BY c.created_at DESC');
    expect(page.text).not.toContain('ILIKE');
    await expect(repo.countFiles('c1', ['OPEN'])).resolves.toBe(1);
  });

  it('should return null for a missing client', async () => {
    const { db, repo } = setup();
    db.client.findFirst.mockResolvedValue(null);
    await expect(repo.get('c1')).resolves.toBeNull();
  });
});
