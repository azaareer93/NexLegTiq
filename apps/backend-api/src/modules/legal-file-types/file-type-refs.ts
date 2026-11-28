import type { Jurisdiction } from '@nexlegtiq/shared-types';

import { ValidationException } from '../../common/errors/app.exception';
import type { ScopedTransaction } from '../../database/unit-of-work';

const unknownType = (field: string) =>
  new ValidationException([{ field, message: 'validation.unknownFileType' }]);
const unknownSubType = () =>
  new ValidationException([{ field: 'subTypeId', message: 'validation.unknownSubType' }]);

/**
 * A new file's type must be an active type of its country and its sub-type an active sub-type of that type, else
 * 400 VAL-001 (D-261). Returns the type's `{TYPE}` number code. The composite foreign keys are the backstop.
 */
export async function assertNewFileType(
  tx: ScopedTransaction,
  jurisdiction: Jurisdiction,
  code: string,
  subTypeId: string | undefined,
): Promise<string> {
  const [type, subTypeOk] = await Promise.all([
    tx.legalFileType.findFirst({
      where: { jurisdiction, code, isActive: true },
      select: { numberCode: true },
    }),
    subTypeId === undefined || activeSubType(tx, subTypeId, jurisdiction, code),
  ]);
  if (!type) throw unknownType('fileType');
  if (!subTypeOk) throw unknownSubType();
  return type.numberCode;
}

/**
 * The sub-type a PATCH leaves on a file; `{}` when it does not touch it. Picking one (or clearing it) drops the legacy
 * free text. A newly picked sub-type must be active and of the file's type; keeping a deactivated one is fine.
 */
export async function nextSubType(
  tx: ScopedTransaction,
  file: { jurisdiction: Jurisdiction; fileType: string; subTypeId: string | null },
  subTypeId: string | null | undefined,
): Promise<{ subTypeId?: string | null; legacySubType?: null }> {
  if (subTypeId === undefined) return {};
  if (
    subTypeId !== null &&
    subTypeId !== file.subTypeId &&
    !(await activeSubType(tx, subTypeId, file.jurisdiction, file.fileType))
  ) {
    throw unknownSubType();
  }
  return { subTypeId, legacySubType: null };
}

/** A task template's type: an active type of the office's country (null = every type). */
export async function assertOfficeFileType(
  tx: ScopedTransaction,
  code: string | null | undefined,
): Promise<void> {
  if (code === null || code === undefined) return;
  const { jurisdiction } = await tx.office.findFirstOrThrow({ select: { jurisdiction: true } });
  const found = await tx.legalFileType.count({ where: { jurisdiction, code, isActive: true } });
  if (found !== 1) throw unknownType('fileType');
}

async function activeSubType(
  tx: ScopedTransaction,
  id: string,
  jurisdiction: Jurisdiction,
  typeCode: string,
): Promise<boolean> {
  const where = { id, jurisdiction, typeCode, isActive: true };
  return (await tx.legalFileSubType.count({ where })) === 1;
}
