import {
  BusinessRuleException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import type { ScopedTransaction } from '../../database/unit-of-work';

export interface LockedFile {
  readonly fileNumber: string;
  readonly isConfidential: boolean;
  readonly responsibleLawyerId: string;
  readonly responsibleParalegalId: string | null;
}

/**
 * Locks the file row (`FOR NO KEY UPDATE`: inserts referencing it still pass) and re-checks it inside the write, as
 * party and folder writes do (D-119, D-135): deleted meanwhile → 404, archived meanwhile → BIZ-007. Writes on one file's
 * clients and team queue behind each other, so "the last client" and "one responsible lawyer" hold.
 */
export async function lockFile(
  tx: ScopedTransaction,
  officeId: string,
  fileId: string,
): Promise<LockedFile> {
  const [file] = await tx.$queryRaw<
    {
      status: string;
      deleted: boolean;
      fileNumber: string;
      isConfidential: boolean;
      responsibleLawyerId: string;
      responsibleParalegalId: string | null;
    }[]
  >`
    SELECT status::text AS status, deleted_at IS NOT NULL AS deleted, file_number AS "fileNumber",
      is_confidential AS "isConfidential", responsible_lawyer_id::text AS "responsibleLawyerId",
      responsible_paralegal_id::text AS "responsibleParalegalId"
    FROM legal_files WHERE id = ${fileId}::uuid AND office_id = ${officeId}::uuid FOR NO KEY UPDATE`;
  if (!file || file.deleted) throw new ResourceNotFoundException();
  if (file.status === 'ARCHIVED') {
    throw new BusinessRuleException('BIZ-007', 'The file is archived and read-only');
  }
  const { status: _status, deleted: _deleted, ...locked } = file;
  return locked;
}
