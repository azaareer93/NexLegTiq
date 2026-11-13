import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Permission, Role } from '@nexlegtiq/shared-types';
import type { ClsService } from 'nestjs-cls';

import { fileVisibleSql, SearchService, snippetParts } from './search.service';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { DocumentAccessService } from '../documents/document-access.service';
import type { CaseAccessService } from '../legal-files/case-access.service';
import type { TaskAccessService } from '../tasks/task-access.service';

const START = '\u0001';
const STOP = '\u0002';

describe('snippetParts (D-167)', () => {
  it('should split ts_headline markers into plain-text parts', () => {
    expect(snippetParts(`the ${START}orchard${STOP} rent and ${START}orchard${STOP}`)).toEqual([
      { text: 'the ', match: false },
      { text: 'orchard', match: true },
      { text: ' rent and ', match: false },
      { text: 'orchard', match: true },
    ]);
  });

  it('should return no parts for an empty headline and keep text without markers', () => {
    expect(snippetParts('')).toEqual([]);
    expect(snippetParts('<b>x</b>')).toEqual([{ text: '<b>x</b>', match: false }]);
  });
});

const ME = '01920000-0000-7000-8000-0000000000a1';
const OFFICE = '01920000-0000-7000-8000-0000000000f1';
const FILE = { id: 'f1', fileNumber: '2026-LIT-00001', title: 'Rent claim' };

type Ctx = { role: Role; permissions: Permission[] } | null;
const ctxOf = (role: Role): Ctx => ({ role, permissions: [...permissionsFor(role)] });
const hit = (id: string) => ({ id, rank: 1 });

// Each searchQuery names its table; the snippet query is the only one with ts_headline.
const TABLES: [string, string][] = [
  ['FROM "legal_files" t', 'files'],
  ['FROM "clients" t', 'clients'],
  ['FROM "parties" t', 'parties'],
  ['FROM "document_texts" t, q', 'texts'],
  ['FROM "tasks" t', 'tasks'],
];

function build(ctx: Ctx, rows: Partial<Record<string, unknown[]>> = {}) {
  const values: Record<string, unknown> = ctx
    ? { officeId: OFFICE, userId: ME, role: ctx.role, permissions: ctx.permissions }
    : {};
  const cls = { get: (key: string) => values[key] } as unknown as ClsService<RequestContext>;
  // The snippet query is a tagged template (strings array); searchQuery passes a Prisma.Sql.
  const $queryRaw = jest.fn((sql: Prisma.Sql | TemplateStringsArray) => {
    if (Array.isArray(sql)) return Promise.resolve(rows.snippets ?? []);
    if (!('sql' in sql)) throw new Error('unexpected query');
    const table = TABLES.find(([from]) => sql.sql.includes(from))?.[1];
    return Promise.resolve(rows[`${table}Hits`] ?? []);
  });
  const model = (name: string) => ({
    findMany: jest.fn(() => Promise.resolve(rows[name] ?? [])),
  });
  const db = {
    $queryRaw,
    legalFile: model('files'),
    client: model('clients'),
    party: model('parties'),
    documentText: model('texts'),
    document: model('documents'),
    task: model('tasks'),
  };
  const access = { visibleWhere: () => ({}) };
  const service = new SearchService(
    cls,
    { db } as unknown as PrismaService,
    access as unknown as CaseAccessService,
    access as unknown as DocumentAccessService,
    access as unknown as TaskAccessService,
  );
  return { service, db };
}

describe('SearchService (D-167)', () => {
  it('should return every group in rank order, with hasMore past the limit', async () => {
    const { service } = build(ctxOf('OFFICE_MANAGER'), {
      filesHits: [hit('f2'), hit('f1')],
      files: [
        { ...FILE, status: 'OPEN' },
        { ...FILE, id: 'f2', status: 'OPEN' },
      ],
      clientsHits: [hit('c1')],
      clients: [{ id: 'c1', displayName: 'Haddad', clientType: 'INDIVIDUAL' }],
      partiesHits: [hit('p1'), hit('p2')],
      parties: [
        { id: 'p1', isIndividual: true, fullName: 'Saleh', companyName: null },
        { id: 'p2', isIndividual: false, fullName: null, companyName: 'Al Noor' },
      ],
      tasksHits: [hit('t1'), hit('t2')],
      tasks: [
        {
          id: 't1',
          title: 'File it',
          status: 'TODO',
          dueDate: new Date('2026-11-20T00:00:00Z'),
          file: FILE,
        },
        { id: 't2', title: 'Call', status: 'TODO', dueDate: null, file: null },
      ],
    });
    const first = await service.search({ q: 'rent', type: 'all', limit: 1 });
    expect(first.cases).toEqual({ items: [{ ...FILE, id: 'f2', status: 'OPEN' }], hasMore: true });
    expect(first.clients.hasMore).toBe(false);
    expect(first.parties.items).toEqual([{ id: 'p1', name: 'Saleh', isIndividual: true }]);
    expect(first.tasks.items[0]?.dueDate).toBe('2026-11-20');
    const all = await service.search({ q: 'rent', type: 'all', limit: 5 });
    expect(all.parties.items[1]?.name).toBe('Al Noor');
    expect(all.tasks.items[1]?.dueDate).toBeNull();
    expect(all.documents).toEqual({ items: [], hasMore: false });
  });

  it('should leave out clients and parties without those rights, and other types when one is asked', async () => {
    const { service, db } = build(ctxOf('TRAINEE'), { clientsHits: [hit('c1')] });
    const found = await service.search({ q: 'rent', type: 'all', limit: 5 });
    expect(found.clients.items).toEqual([]);
    expect(db.client.findMany).not.toHaveBeenCalled();
    expect(db.party.findMany).not.toHaveBeenCalled();
    await service.search({ q: 'rent', type: 'tasks', limit: 5 });
    expect(db.legalFile.findMany).toHaveBeenCalledTimes(1);
  });

  it('should keep only current-version documents that pass the re-check, with their snippet', async () => {
    const { service } = build(ctxOf('SENIOR_LAWYER'), {
      textsHits: [hit('x1'), hit('x2'), hit('x3')],
      texts: [
        { id: 'x1', documentId: 'd1', versionNumber: 1 },
        { id: 'x2', documentId: 'd2', versionNumber: 1 },
      ],
      documents: [
        { id: 'd1', name: 'Claim', currentVersion: 1, file: FILE },
        { id: 'd2', name: 'Old', currentVersion: 2, file: FILE },
      ],
      snippets: [{ documentId: 'd1', headline: `the ${START}rent${STOP}` }],
    });
    const found = await service.search({ q: 'rent', type: 'documents', limit: 5 });
    expect(found.documents.items).toEqual([
      {
        id: 'd1',
        name: 'Claim',
        file: FILE,
        snippet: [
          { text: 'the ', match: false },
          { text: 'rent', match: true },
        ],
      },
    ]);
  });

  it('should return no documents when none passes the re-check, or a snippet-less one as empty', async () => {
    const none = build(ctxOf('OFFICE_MANAGER'), {
      textsHits: [hit('x1')],
      texts: [{ id: 'x1', documentId: 'd1', versionNumber: 1 }],
    });
    const found = await none.service.search({ q: 'rent', type: 'documents', limit: 5 });
    expect(found.documents.items).toEqual([]);
    const bare = build(ctxOf('OFFICE_MANAGER'), {
      textsHits: [hit('x1')],
      texts: [{ id: 'x1', documentId: 'd1', versionNumber: 1 }],
      documents: [{ id: 'd1', name: 'Claim', currentVersion: 1, file: FILE }],
    });
    const result = await bare.service.search({ q: 'rent', type: 'documents', limit: 5 });
    expect(result.documents.items[0]?.snippet).toEqual([]);
  });

  it('should fail loudly without an office caller', async () => {
    await expect(build(null).service.search({ q: 'rent', type: 'all', limit: 5 })).rejects.toThrow(
      'No office caller',
    );
  });
});

describe('fileVisibleSql', () => {
  const caller = (role: Role) => ({
    officeId: OFFICE,
    userId: ME,
    role,
    permissions: [...permissionsFor(role)],
  });

  it('should narrow by scope and confidentiality like caseScopeWhere', () => {
    expect(fileVisibleSql('f', caller('OFFICE_MANAGER')).sql).not.toContain('is_confidential');
    expect(fileVisibleSql('f', caller('SENIOR_LAWYER')).sql).toContain('NOT f."is_confidential"');
    const assigned = fileVisibleSql('f', caller('LAWYER')).sql;
    expect(assigned).toContain('responsible_lawyer_id');
    expect(assigned).not.toContain('is_confidential');
  });
});
