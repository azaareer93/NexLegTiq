import { ValidationException } from '../../common/errors/app.exception';
import type { ScopedTransaction } from '../../database/unit-of-work';

interface CourtRefs {
  readonly courtId: string | null;
  readonly judgeId: string | null;
}

/**
 * A file's court must be visible to the office (a platform court or one of its own) and its judge must sit at that
 * court, else 400 VAL-001 (`validation.unknownCourt` / `validation.unknownJudge`). The database triggers enforce the
 * same rule as a backstop (D-115).
 */
export async function assertCourtRefs(
  tx: ScopedTransaction,
  { courtId = null, judgeId = null }: Partial<CourtRefs>,
): Promise<void> {
  const [court, judge] = await Promise.all([
    courtId ? tx.court.count({ where: { id: courtId } }) : 1,
    judgeId && courtId ? tx.judge.count({ where: { id: judgeId, courtId } }) : judgeId ? 0 : 1,
  ]);
  const details = [
    ...(court === 1 ? [] : [{ field: 'courtId', message: 'validation.unknownCourt' }]),
    ...(judge === 1 ? [] : [{ field: 'judgeId', message: 'validation.unknownJudge' }]),
  ];
  if (details.length > 0) throw new ValidationException(details);
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
  await assertCourtRefs(tx, { courtId, judgeId });
  return { courtId, judgeId };
}
