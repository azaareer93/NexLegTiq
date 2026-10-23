import type { ConflictReason } from '@nexlegtiq/shared-contracts';
import type { PartyType } from '@nexlegtiq/shared-types';

import type { ScopedTransaction } from '../../database/unit-of-work';
import { Prisma } from '../../generated/prisma/client';

/**
 * The dispute sides (D-135): a party in one of these roles stands against someone on the file. Third parties, guarantors,
 * signatories and interested parties are not adverse.
 */
export const ADVERSE_TYPES: readonly PartyType[] = [
  'PLAINTIFF',
  'DEFENDANT',
  'APPELLANT',
  'RESPONDENT',
  'PROSECUTION',
];
/** Open files (as for BIZ-010, D-108): a closed, archived or deleted matter raises no conflict. */
const OPEN_STATUSES = ['OPEN', 'SUSPENDED'] as const;
const isAdverse = (types: Iterable<PartyType>) => [...types].some((t) => ADVERSE_TYPES.includes(t));

export interface ConflictParty {
  readonly id: string;
  readonly name: string;
  readonly nationalIdIndex: string | null;
  readonly taxIdIndex: string | null;
}

/** A conflict row that no longer holds and was taken away (the caller audits it). */
export interface WithdrawnConflict {
  readonly id: string;
  readonly otherFileId: string;
}

/**
 * Brings the open conflicts of a party on a file in line with W9 (D-135), whatever just changed (added, retyped, removed).
 * The caller holds the party's row lock, so two writes about the same party never miss each other. A pair of files is in
 * conflict over the party when, both files being open:
 * - the party has roles on both and at least one of them is a dispute side (`ADVERSE_ON_OTHER_FILE`), or
 * - the party is adverse on one file and the client of the other (`CLIENT_ON_OTHER_FILE`; id blind index or normalised
 *   name).
 * Missing rows are created once per pair (either order); open rows that no longer hold are deleted and returned for the
 * audit; resolved rows are history and never touched.
 */
export async function syncConflicts(
  tx: ScopedTransaction,
  officeId: string,
  fileId: string,
  party: ConflictParty,
): Promise<WithdrawnConflict[]> {
  const roles = await tx.fileParty.findMany({
    where: {
      partyId: party.id,
      file: { deletedAt: null, status: { in: [...OPEN_STATUSES] } },
    },
    select: { fileId: true, partyType: true },
  });
  const typesOn = new Map<string, PartyType[]>();
  for (const role of roles)
    typesOn.set(role.fileId, [...(typesOn.get(role.fileId) ?? []), role.partyType]);
  const justified = justifiedPairs(fileId, typesOn, await clientFilesOf(tx, officeId, party));
  return applyPairs(tx, officeId, fileId, party.id, justified);
}

/** The other files in conflict with `fileId` over the party, and why (the two rules above, both directions). */
export function justifiedPairs(
  fileId: string,
  typesOn: ReadonlyMap<string, readonly PartyType[]>,
  clientOf: ReadonlySet<string>,
): Map<string, ConflictReason> {
  const here = typesOn.get(fileId) ?? [];
  const justified = new Map<string, ConflictReason>();
  for (const [other, types] of typesOn) {
    const reason = other === fileId ? null : reasonBetween(here, types, clientOf.has(fileId));
    if (reason) justified.set(other, reason);
  }
  if (isAdverse(here)) {
    for (const other of clientOf)
      if (other !== fileId) justified.set(other, 'CLIENT_ON_OTHER_FILE');
  }
  return justified;
}

/** Why roles `here` and `there` (on another file) conflict, if they do; the client rule wins as the stronger reason. */
function reasonBetween(
  here: readonly PartyType[],
  there: readonly PartyType[],
  clientHere: boolean,
): ConflictReason | null {
  if (isAdverse(there) && clientHere) return 'CLIENT_ON_OTHER_FILE';
  if (here.length > 0 && (isAdverse(here) || isAdverse(there))) return 'ADVERSE_ON_OTHER_FILE';
  return null;
}

/** Creates the missing pairs (either order counts) and deletes the open ones that no longer hold; resolved rows stay. */
async function applyPairs(
  tx: ScopedTransaction,
  officeId: string,
  fileId: string,
  partyId: string,
  justified: ReadonlyMap<string, ConflictReason>,
): Promise<WithdrawnConflict[]> {
  const existing = await tx.conflictOfInterest.findMany({
    where: { partyId, OR: [{ fileIdA: fileId }, { fileIdB: fileId }] },
    select: { id: true, fileIdA: true, fileIdB: true, resolved: true },
  });
  const otherOf = (row: { fileIdA: string; fileIdB: string }) =>
    row.fileIdA === fileId ? row.fileIdB : row.fileIdA;
  const recorded = new Set(existing.map(otherOf));
  const missing = [...justified].filter(([other]) => !recorded.has(other));
  if (missing.length > 0) {
    await tx.conflictOfInterest.createMany({
      data: missing.map(([other, reason]) => ({
        officeId,
        fileIdA: fileId,
        fileIdB: other,
        partyId,
        reason,
      })),
      skipDuplicates: true,
    });
  }
  const withdrawn = existing
    .filter((row) => !row.resolved && !justified.has(otherOf(row)))
    .map((row) => ({ id: row.id, otherFileId: otherOf(row) }));
  if (withdrawn.length > 0) {
    await tx.conflictOfInterest.deleteMany({
      where: { id: { in: withdrawn.map((row) => row.id) } },
    });
  }
  return withdrawn;
}

/** Open files whose live client is this party: same id index, or the same normalised name. */
async function clientFilesOf(
  tx: ScopedTransaction,
  officeId: string,
  party: ConflictParty,
): Promise<Set<string>> {
  const ids = [
    party.nationalIdIndex && Prisma.sql`c.national_id_index = ${party.nationalIdIndex}`,
    party.taxIdIndex && Prisma.sql`c.tax_id_index = ${party.taxIdIndex}`,
  ].filter((condition): condition is Prisma.Sql => Boolean(condition));
  const rows = await tx.$queryRaw<{ file_id: string }[]>`
    SELECT DISTINCT fc.file_id
    FROM file_clients fc
    JOIN clients c ON c.id = fc.client_id AND c.office_id = fc.office_id
    JOIN legal_files f ON f.id = fc.file_id AND f.office_id = fc.office_id
    WHERE fc.office_id = ${officeId}::uuid
      AND c.deleted_at IS NULL
      AND f.deleted_at IS NULL
      AND f.status::text IN (${Prisma.join(OPEN_STATUSES)})
      AND (
        ${Prisma.join(
          [
            ...ids,
            Prisma.sql`nlq_normalize_ar(btrim(${party.name})) IN (
              nlq_normalize_ar(btrim(c.display_name)),
              nlq_normalize_ar(btrim(coalesce(c.full_name, c.company_name, c.display_name)))
            )`,
          ],
          ' OR ',
        )}
      )`;
  return new Set(rows.map((row) => row.file_id));
}
