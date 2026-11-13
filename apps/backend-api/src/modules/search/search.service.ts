import { Injectable } from '@nestjs/common';
import type {
  SearchQuery,
  SearchResults,
  SearchType,
  SnippetPart,
} from '@nexlegtiq/shared-contracts';
import type { Permission, Role } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../../common/context/request-context';
import { searchQuery } from '../../common/search/search-query';
import type { SearchHit, SearchTarget } from '../../common/search/search-query';
import { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { DocumentAccessService } from '../documents/document-access.service';
import { CaseAccessService } from '../legal-files/case-access.service';
import { TaskAccessService } from '../tasks/task-access.service';

export interface SearchCaller {
  readonly officeId: string;
  readonly userId: string;
  readonly role: Role;
  readonly permissions: readonly Permission[];
}

const FILE_REF = { id: true, fileNumber: true, title: true } as const;
// Snippet markers: control characters, stripped from the text first, so they can only come from ts_headline.
const START = '\u0001';
const STOP = '\u0002';
// shortcut: snippets are cut from the first 100,000 characters of a text; read further if long documents miss them.
const SNIPPET_SOURCE_CHARS = 50_000;
const HEADLINE_OPTIONS = `StartSel=${START}, StopSel=${STOP}, MaxWords=25, MinWords=10, MaxFragments=2, FragmentDelimiter=" … "`;

/**
 * Global search (D-167). Each type runs its own ranked query (D-165) with the reader's visibility as SQL, so the limit
 * applies to rows they may open; the rows are then read through the Prisma access rules again (D-096, D-098, D-126),
 * which drop anything the SQL let through — results can only shrink, never leak.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly files: CaseAccessService,
    private readonly documents: DocumentAccessService,
    private readonly tasks: TaskAccessService,
  ) {}

  async search({ q, type, limit }: SearchQuery): Promise<SearchResults> {
    const caller = this.caller();
    const may = (...wanted: Permission[]) => wanted.some((p) => caller.permissions.includes(p));
    const run = <T>(t: SearchType, allowed: boolean, find: () => Promise<T[]>): Promise<T[]> =>
      (type === 'all' || type === t) && allowed ? find() : Promise.resolve([]);
    const hits = (target: SearchTarget, where: Prisma.Sql) =>
      this.prisma.db.$queryRaw<SearchHit[]>(
        searchQuery(target, caller.officeId, q, limit + 1, where),
      );
    // hasMore counts rows before the Prisma re-check; a row it drops (a drift, rare) can leave a short page with hasMore.
    const page = <T>(items: T[]) => ({
      items: items.slice(0, limit),
      hasMore: items.length > limit,
    });

    const [cases, clients, parties, documents, tasks] = await Promise.all([
      run('cases', true, async () => this.cases(await hits('files', fileVisibleSql('t', caller)))),
      run('clients', may('manage:clients'), async () =>
        this.clients(await hits('clients', Prisma.sql`t."deleted_at" IS NULL`)),
      ),
      // The registry is office-wide (D-135): a picker for those who add parties to files.
      run('parties', may('edit:any:case', 'edit:assigned:case'), async () =>
        this.parties(await hits('parties', Prisma.sql`TRUE`)),
      ),
      run('documents', true, async () =>
        this.documentHits(
          caller.officeId,
          q,
          await hits('documents', documentTextVisibleSql(caller)),
        ),
      ),
      run('tasks', true, async () => this.taskHits(await hits('tasks', taskVisibleSql(caller)))),
    ]);
    return {
      cases: page(cases),
      clients: page(clients),
      parties: page(parties),
      documents: page(documents),
      tasks: page(tasks),
    };
  }

  private async cases(found: SearchHit[]) {
    const ids = found.map((h) => h.id);
    const rows = await this.prisma.db.legalFile.findMany({
      where: { AND: [{ id: { in: ids } }, this.files.visibleWhere()] },
      select: { ...FILE_REF, status: true },
    });
    return inOrder(ids, rows);
  }

  private async clients(found: SearchHit[]) {
    const ids = found.map((h) => h.id);
    const rows = await this.prisma.db.client.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, displayName: true, clientType: true },
    });
    return inOrder(ids, rows);
  }

  private async parties(found: SearchHit[]) {
    const ids = found.map((h) => h.id);
    const rows = await this.prisma.db.party.findMany({
      where: { id: { in: ids } },
      select: { id: true, isIndividual: true, fullName: true, companyName: true },
    });
    return inOrder(ids, rows).map((p) => ({
      id: p.id,
      name: p.fullName ?? p.companyName ?? '',
      isIndividual: p.isIndividual,
    }));
  }

  private async documentHits(officeId: string, q: string, found: SearchHit[]) {
    const textIds = found.map((h) => h.id);
    if (textIds.length === 0) return [];
    const texts = await this.prisma.db.documentText.findMany({
      where: { id: { in: textIds } },
      select: { id: true, documentId: true, versionNumber: true },
    });
    const byText = new Map(texts.map((t) => [t.id, t]));
    const documentIds = textIds.flatMap((id) => byText.get(id)?.documentId ?? []);
    // Re-check: visible, scanned clean and still on the version whose text matched (D-126, D-128).
    const docs = await this.prisma.db.document.findMany({
      where: {
        AND: [{ id: { in: documentIds } }, { status: 'READY' }, this.documents.visibleWhere()],
      },
      select: { id: true, name: true, currentVersion: true, file: { select: FILE_REF } },
    });
    const current = inOrder(documentIds, docs).filter((d) =>
      texts.some((t) => t.documentId === d.id && t.versionNumber === d.currentVersion),
    );
    const visibleTextIds = texts
      .filter((t) =>
        current.some((d) => d.id === t.documentId && d.currentVersion === t.versionNumber),
      )
      .map((t) => t.id);
    if (visibleTextIds.length === 0) return [];
    // Highlight on the text as written; when the match came from an Arabic letter variant (D-059), on the normalised text.
    const snippets = await this.prisma.db.$queryRaw<{ documentId: string; headline: string }[]>`
      SELECT s."documentId", CASE WHEN position(${START} in s.raw) > 0 THEN s.raw ELSE
               ts_headline('simple', nlq_normalize_ar(s.src),
                           websearch_to_tsquery('simple', nlq_normalize_ar(unaccent(${q}::text))), ${HEADLINE_OPTIONS})
             END AS headline
      FROM (
        SELECT x."document_id"::text AS "documentId", x.src,
               ts_headline('simple', x.src, websearch_to_tsquery('simple', unaccent(${q}::text)), ${HEADLINE_OPTIONS}) AS raw
        FROM (SELECT t."document_id", translate(left(t."text", ${SNIPPET_SOURCE_CHARS}), ${START + STOP}, '') AS src
              FROM "document_texts" t
              WHERE t."office_id" = ${officeId}::uuid AND t."id" = ANY(${visibleTextIds}::uuid[])) x
      ) s`;
    const headlines = new Map(snippets.map((s) => [s.documentId, s.headline]));
    return current.map(({ currentVersion: _version, ...d }) => ({
      ...d,
      snippet: snippetParts(headlines.get(d.id) ?? ''),
    }));
  }

  private async taskHits(found: SearchHit[]) {
    const ids = found.map((h) => h.id);
    const rows = await this.prisma.db.task.findMany({
      where: { AND: [{ id: { in: ids } }, this.tasks.visibleWhere()] },
      select: { id: true, title: true, status: true, dueDate: true, file: { select: FILE_REF } },
    });
    return inOrder(ids, rows).map((t) => ({
      ...t,
      dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
    }));
  }

  private caller(): SearchCaller {
    const officeId = this.cls.get('officeId');
    const userId = this.cls.get('userId');
    const role = this.cls.get('role');
    const permissions = this.cls.get('permissions');
    // Guarded route: a missing value is a programming error (500), never a 403 that would hide it.
    if (!officeId || !userId || !role || !permissions) {
      throw new Error('No office caller in the request context');
    }
    return { officeId, userId, role, permissions };
  }
}

/** Rows in the order of `ids` (the rank); ids the access re-check dropped are left out. */
function inOrder<T extends { id: string }>(ids: readonly string[], rows: readonly T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/** `ts_headline` output split on its markers into plain-text parts (never HTML). */
export function snippetParts(headline: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  headline.split(START).forEach((chunk, i) => {
    const [match, rest] =
      i === 0 ? ['', chunk] : [chunk.split(STOP)[0], chunk.split(STOP).slice(1).join('')];
    if (match) parts.push({ text: match, match: true });
    if (rest) parts.push({ text: rest, match: false });
  });
  return parts;
}

/** D-051 "assigned" on a `legal_files` alias, as `assignedFilesWhere`. */
function assignedSql(f: string, userId: string): Prisma.Sql {
  const a = Prisma.raw(f);
  return Prisma.sql`(${a}."responsible_lawyer_id" = ${userId}::uuid OR ${a}."responsible_paralegal_id" = ${userId}::uuid
    OR EXISTS (SELECT 1 FROM "file_team_members" m
               WHERE m."file_id" = ${a}."id" AND m."office_id" = ${a}."office_id" AND m."user_id" = ${userId}::uuid))`;
}

/** `CaseAccessService.visibleWhere` as SQL on a `legal_files` alias (kept in step by `search.int.spec.ts`). */
export function fileVisibleSql(f: string, c: SearchCaller): Prisma.Sql {
  const live = Prisma.sql`${Prisma.raw(f)}."deleted_at" IS NULL`;
  if (!c.permissions.includes('view:all:cases')) {
    return Prisma.sql`${live} AND ${assignedSql(f, c.userId)}`;
  }
  if (c.role === 'OFFICE_MANAGER') return live;
  return Prisma.sql`${live} AND (NOT ${Prisma.raw(f)}."is_confidential" OR ${assignedSql(f, c.userId)})`;
}

/** The current version's text of a READY document the caller may open (`DocumentAccessService.visibleWhere`). */
function documentTextVisibleSql(c: SearchCaller): Prisma.Sql {
  const confidential =
    c.role === 'OFFICE_MANAGER'
      ? Prisma.empty
      : Prisma.sql`AND (NOT d."is_confidential" OR d."uploaded_by_id" = ${c.userId}::uuid OR ${assignedSql('f', c.userId)})`;
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "documents" d JOIN "legal_files" f ON f."id" = d."file_id" AND f."office_id" = d."office_id"
    WHERE d."id" = t."document_id" AND d."office_id" = t."office_id" AND d."deleted_at" IS NULL
      AND d."status" = 'READY' AND d."current_version" = t."version_number"
      AND ${fileVisibleSql('f', c)} ${confidential})`;
}

/** Tasks on a visible file, plus the caller's personal tasks (`TaskAccessService.visibleWhere`). */
function taskVisibleSql(c: SearchCaller): Prisma.Sql {
  return Prisma.sql`(
    (t."file_id" IS NULL AND (t."created_by_id" = ${c.userId}::uuid OR t."assigned_to_id" = ${c.userId}::uuid))
    OR EXISTS (SELECT 1 FROM "legal_files" f
               WHERE f."id" = t."file_id" AND f."office_id" = t."office_id" AND ${fileVisibleSql('f', c)}))`;
}
