import { Prisma } from '../../generated/prisma/client';

/**
 * What global search can look in (D-165). `trigram` is the Arabic-normalised expression with a trigram index, matched for
 * typos and partial words; it must be written exactly as in the index (migration `search_vectors`, D-135 for parties).
 * Identifiers come only from this constant, never from input.
 */
export const SEARCH_TARGETS = {
  files: { table: 'legal_files', trigram: 'nlq_normalize_ar(t."title")' },
  clients: { table: 'clients', trigram: 'nlq_normalize_ar(t."display_name")' },
  parties: {
    table: 'parties',
    trigram: 'nlq_normalize_ar(coalesce(t."full_name", t."company_name"))',
  },
  tasks: { table: 'tasks', trigram: 'nlq_normalize_ar(t."title")' },
  documents: { table: 'document_texts', trigram: null },
  statements: { table: 'witness_statements', trigram: null },
} as const;
export type SearchTarget = keyof typeof SEARCH_TARGETS;

/**
 * Word matches ranked per query (D-235): the newest 1,000 (ids are UUIDv7). A common word ("عقد") matches most of an
 * office's documents, and `ts_rank` over 15k document vectors took 0.5 s alone; past a thousand matches the word does not
 * tell rows apart anyway, recency does.
 */
export const RANKED_CANDIDATES = 1_000;

export interface SearchHit {
  readonly id: string;
  readonly rank: number;
}

/**
 * Ranked ids of one target's rows in the office that match `query` (D-059): `websearch_to_tsquery` on the `simple`
 * (Arabic-normalised) and `english` vectors, or a trigram match on the name/title, ranked by `ts_rank` (+ similarity).
 * `where` is required: the caller states which rows the reader may see (deleted, confidential, personal tasks…) on the
 * alias `t`, before the limit applies. Word matches rank `1 + ts_rank…` (> 1) and always come before trigram matches,
 * `word_similarity` (≤ 1), which fill the remaining places only (a typo, a partial name). Only the newest
 * `RANKED_CANDIDATES` word matches are ranked. `documents` returns
 * `document_texts.id` (one row per version), `statements` the statement id.
 */
export function searchQuery(
  target: SearchTarget,
  officeId: string,
  query: string,
  limit: number,
  where: Prisma.Sql,
): Prisma.Sql {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('search limit must be an integer from 1 to 100');
  }
  const { table, trigram } = SEARCH_TARGETS[target];
  const from = Prisma.raw(`"${table}"`);
  // The tsqueries are written inline, not read from the CTE: from a CTE the planner cannot use them as index
  // conditions and may scan the whole table (seen on CI with 50k files).
  const simple = Prisma.sql`websearch_to_tsquery('simple', nlq_normalize_ar(unaccent(${query}::text)))`;
  const english = Prisma.sql`websearch_to_tsquery('english', unaccent(${query}::text))`;
  const words = Prisma.sql`t."search_vector_simple" @@ ${simple} OR t."search_vector_english" @@ ${english}`;
  const scope = Prisma.sql`t."office_id" = ${officeId}::uuid AND (${where})`;
  // Word matches rank first (1 + ts_rank); the trigram pass only runs when they leave room under the limit.
  const fuzzy = trigram
    ? Prisma.sql`
      UNION ALL
      SELECT * FROM (
        SELECT t."id", word_similarity(q.n, ${Prisma.raw(trigram)})::float8 AS rank
        FROM ${from} t, q
        WHERE ${scope} AND q.n <% ${Prisma.raw(trigram)} AND NOT coalesce((${words}), false)
          AND (SELECT count(*) FROM hits) < ${limit}
        ORDER BY rank DESC, t."id"
        LIMIT ${limit}
      ) near`
    : Prisma.empty;
  return Prisma.sql`
    WITH q AS (
      SELECT websearch_to_tsquery('simple', nlq_normalize_ar(unaccent(${query}::text))) AS s,
             websearch_to_tsquery('english', unaccent(${query}::text)) AS e,
             nlq_normalize_ar(${query}::text) AS n
    ),
    hits AS (
      SELECT c."id", (1 + ts_rank(c."search_vector_simple", q.s) + ts_rank(c."search_vector_english", q.e))::float8 AS rank
      FROM (
        SELECT t."id", t."search_vector_simple", t."search_vector_english"
        FROM ${from} t
        WHERE ${scope} AND (${words})
        ORDER BY t."id" DESC
        LIMIT ${Prisma.raw(String(RANKED_CANDIDATES))} -- a literal, so every plan (generic ones too) knows the cap
      ) c, q
      ORDER BY rank DESC, c."id"
      LIMIT ${limit}
    )
    SELECT id::text AS id, rank FROM (SELECT * FROM hits ${fuzzy}) found
    ORDER BY rank DESC, id
    LIMIT ${limit}`;
}
