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
/** Open files (as for BIZ-010, D-108): a closed or archived matter raises no conflict. */
const OPEN_STATUSES = ['OPEN', 'SUSPENDED'] as const;

export interface ConflictParty {
  readonly id: string;
  readonly name: string;
  readonly nationalIdIndex: string | null;
  readonly taxIdIndex: string | null;
}

/**
 * Conflict check of W9 for a party on a file (D-135), run in the transaction that adds or retypes it: the party is on
 * another open file on a dispute side, or — when it is adverse here — it is the client of another open file (matched by
 * a national/tax id blind index or by Arabic-normalised name). Each pair of files and party is recorded once, whichever
 * file came first; a resolved conflict is never raised again. Returns nothing: callers read the open conflicts afterwards.
 */
export async function detectConflicts(
  tx: ScopedTransaction,
  officeId: string,
  fileId: string,
  party: ConflictParty,
  partyType: PartyType,
): Promise<void> {
  const openFile = { deletedAt: null, status: { in: [...OPEN_STATUSES] } };
  const adverseElsewhere = await tx.fileParty.findMany({
    where: {
      partyId: party.id,
      fileId: { not: fileId },
      partyType: { in: [...ADVERSE_TYPES] },
      file: openFile,
    },
    select: { fileId: true },
  });
  const found = new Map<string, ConflictReason>(
    adverseElsewhere.map((row) => [row.fileId, 'ADVERSE_ON_OTHER_FILE']),
  );
  if (ADVERSE_TYPES.includes(partyType)) {
    for (const otherFileId of await clientFilesOf(tx, officeId, fileId, party)) {
      found.set(otherFileId, 'CLIENT_ON_OTHER_FILE');
    }
  }
  for (const [otherFileId, reason] of found) {
    const known = await tx.conflictOfInterest.findFirst({
      where: {
        partyId: party.id,
        OR: [
          { fileIdA: fileId, fileIdB: otherFileId },
          { fileIdA: otherFileId, fileIdB: fileId },
        ],
      },
      select: { id: true },
    });
    if (known) continue;
    await tx.conflictOfInterest.create({
      data: { officeId, fileIdA: fileId, fileIdB: otherFileId, partyId: party.id, reason },
    });
  }
}

/** Open files (other than this one) whose live client is this party: same id index, or the same normalised name. */
async function clientFilesOf(
  tx: ScopedTransaction,
  officeId: string,
  fileId: string,
  party: ConflictParty,
): Promise<string[]> {
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
      AND fc.file_id <> ${fileId}::uuid
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
  return rows.map((row) => row.file_id);
}
