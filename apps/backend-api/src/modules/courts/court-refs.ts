import { ValidationException } from '../../common/errors/app.exception';
import type { ScopedTransaction } from '../../database/unit-of-work';

interface CourtRefs {
  readonly courtId: string | null;
  readonly judgeId: string | null;
}

/**
 * A file's court must be visible to the office (a platform court or one of its own) and its judge must sit at that
 * court, else 400 VAL-001 (`validation.unknownCourt` / `validation.unknownJudge`). A newly assigned judge must be active
 * (a retired judge stays on the files that already name them). The database triggers are the backstop (D-115).
 */
export async function assertCourtRefs(
  tx: ScopedTransaction,
  { courtId = null, judgeId = null }: Partial<CourtRefs>,
  newJudge = true,
  /** Prepended to the error fields, e.g. `nextSession.` for a nested object. */
  fieldPrefix = '',
): Promise<void> {
  const [courtOk, judgeOk] = await Promise.all([
    courtId === null || tx.court.count({ where: { id: courtId } }).then((n) => n === 1),
    judgeId === null || judgeAt(tx, judgeId, courtId, newJudge),
  ]);
  const details = [
    ...(courtOk ? [] : [{ field: `${fieldPrefix}courtId`, message: 'validation.unknownCourt' }]),
    ...(judgeOk ? [] : [{ field: `${fieldPrefix}judgeId`, message: 'validation.unknownJudge' }]),
  ];
  if (details.length > 0) throw new ValidationException(details);
}

/** The judge sits at the court (a judge needs a court), and is active when newly assigned. */
async function judgeAt(
  tx: ScopedTransaction,
  id: string,
  courtId: string | null,
  mustBeActive: boolean,
): Promise<boolean> {
  if (courtId === null) return false;
  const where = { id, courtId, ...(mustBeActive && { isActive: true }) };
  return (await tx.judge.count({ where })) === 1;
}

/**
 * The court and judge a PATCH leaves on a file, checked; `{}` when it touches neither. A new court without a judge
 * drops the judge of the old court.
 */
export async function nextCourtRefs(
  tx: ScopedTransaction,
  before: CourtRefs,
  input: { readonly courtId?: string | null; readonly judgeId?: string | null },
): Promise<Partial<CourtRefs>> {
  if (input.courtId === undefined && input.judgeId === undefined) return {};
  const courtId = input.courtId === undefined ? before.courtId : input.courtId;
  const judgeId =
    input.judgeId !== undefined
      ? input.judgeId
      : courtId === before.courtId
        ? before.judgeId
        : null;
  await assertCourtRefs(tx, { courtId, judgeId }, judgeId !== before.judgeId);
  return { courtId, judgeId };
}
