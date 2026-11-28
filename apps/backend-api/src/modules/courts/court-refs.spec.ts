import { assertCourtRefs, nextCourtRefs } from './court-refs';
import { ValidationException } from '../../common/errors/app.exception';
import type { ScopedTransaction } from '../../database/unit-of-work';

/**
 * A transaction where `courts` and `judges` (judgeId → courtId) are the rows the office can see, and `pickable` the
 * active platform courts of its country (D-266).
 */
function txWith(courts: string[], judges: Record<string, string>, pickable = courts) {
  return {
    office: { findFirstOrThrow: jest.fn().mockResolvedValue({ jurisdiction: 'PALESTINE' }) },
    court: {
      count: jest.fn(({ where }: { where: { id: string; isActive?: boolean } }) =>
        Promise.resolve((where.isActive ? pickable : courts).includes(where.id) ? 1 : 0),
      ),
    },
    judge: {
      count: jest.fn(({ where }: { where: { id: string; courtId: string } }) =>
        Promise.resolve(judges[where.id] === where.courtId ? 1 : 0),
      ),
    },
  } as unknown as ScopedTransaction;
}

const tx = txWith(['c1', 'c2'], { j1: 'c1', j2: 'c2' });
const fieldsOf = async (work: Promise<unknown>) => {
  try {
    await work;
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationException);
    return ((error as ValidationException).details ?? []).map((detail) => detail.message);
  }
};

describe('assertCourtRefs', () => {
  it('should accept no court, a visible court, and a judge of that court', async () => {
    expect(await fieldsOf(assertCourtRefs(tx, { courtId: null, judgeId: null }))).toEqual([]);
    expect(await fieldsOf(assertCourtRefs(tx, { courtId: 'c1', judgeId: 'j1' }))).toEqual([]);
  });

  it('should refuse an unknown court, a judge of another court and a judge without a court', async () => {
    expect(await fieldsOf(assertCourtRefs(tx, { courtId: 'cX', judgeId: null }))).toEqual([
      'validation.unknownCourt',
    ]);
    expect(await fieldsOf(assertCourtRefs(tx, { courtId: 'c1', judgeId: 'j2' }))).toEqual([
      'validation.unknownJudge',
    ]);
    expect(await fieldsOf(assertCourtRefs(tx, { courtId: null, judgeId: 'j1' }))).toEqual([
      'validation.unknownJudge',
    ]);
  });
});

describe('assertCourtRefs with legacy courts (D-266)', () => {
  // c1 is pickable; c3 is an office's legacy court (or a deactivated one) the office still sees.
  const legacy = txWith(['c1', 'c3'], { j3: 'c3' }, ['c1']);

  it('should refuse a newly assigned court that is not an active platform court of the country', async () => {
    expect(await fieldsOf(assertCourtRefs(legacy, { courtId: 'c3' }))).toEqual([
      'validation.unknownCourt',
    ]);
    expect(await fieldsOf(assertCourtRefs(legacy, { courtId: 'c1' }))).toEqual([]);
  });

  it('should keep a court the row already has', async () => {
    expect(
      await fieldsOf(assertCourtRefs(legacy, { courtId: 'c3', judgeId: 'j3' }, true, '', false)),
    ).toEqual([]);
    expect(
      await fieldsOf(nextCourtRefs(legacy, { courtId: 'c3', judgeId: null }, { judgeId: 'j3' })),
    ).toEqual([]);
    expect(
      await fieldsOf(nextCourtRefs(legacy, { courtId: 'c1', judgeId: null }, { courtId: 'c3' })),
    ).toEqual(['validation.unknownCourt']);
  });
});

describe('nextCourtRefs', () => {
  const before = { courtId: 'c1', judgeId: 'j1' };

  it('should change nothing when neither field is sent', async () => {
    expect(await nextCourtRefs(tx, before, {})).toEqual({});
  });

  it('should drop the old judge when only the court changes, and keep it when the court stays', async () => {
    expect(await nextCourtRefs(tx, before, { courtId: 'c2' })).toEqual({
      courtId: 'c2',
      judgeId: null,
    });
    expect(await nextCourtRefs(tx, before, { courtId: 'c1' })).toEqual(before);
    expect(await nextCourtRefs(tx, before, { courtId: null })).toEqual({
      courtId: null,
      judgeId: null,
    });
  });

  it('should take a judge sent with the court, or alone for the current court', async () => {
    expect(await nextCourtRefs(tx, before, { courtId: 'c2', judgeId: 'j2' })).toEqual({
      courtId: 'c2',
      judgeId: 'j2',
    });
    expect(await nextCourtRefs(tx, before, { judgeId: null })).toEqual({
      courtId: 'c1',
      judgeId: null,
    });
    await expect(nextCourtRefs(tx, before, { judgeId: 'j2' })).rejects.toThrow(ValidationException);
  });
});
