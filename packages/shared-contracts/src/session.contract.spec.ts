import {
  CreateSessionSchema,
  SessionOutcomeSchema,
  SessionQuerySchema,
  UpdateSessionSchema,
} from './session.contract.js';

const FILE = '01920000-0000-7000-8000-0000000000f1';
const USER = '01920000-0000-7000-8000-000000000002';

const messages = (result: { error?: { issues: { message: string }[] } }) =>
  (result.error?.issues ?? []).map((issue) => issue.message);

const create = (body: object) =>
  CreateSessionSchema.safeParse({
    fileId: FILE,
    attendingLawyerId: USER,
    startsAt: '2026-11-02T09:30:00+02:00',
    ...body,
  });

describe('CreateSessionSchema', () => {
  it('should default the type and the acknowledgement and keep the offset as sent', () => {
    expect(create({}).data).toEqual({
      fileId: FILE,
      attendingLawyerId: USER,
      startsAt: '2026-11-02T09:30:00+02:00',
      sessionType: 'HEARING',
      acknowledgeConflict: false,
    });
  });

  it('should refuse a time without an offset, an end before the start and a judge without a court', () => {
    expect(messages(create({ startsAt: '2026-11-02T09:30:00' }))).toEqual(['validation.dateTime']);
    expect(messages(create({ endsAt: '2026-11-02T07:00:00Z' }))).toEqual([
      'validation.endsBeforeStart',
    ]);
    expect(messages(create({ judgeId: USER }))).toEqual(['validation.unknownJudge']);
  });

  it('should limit reminder days to 0–365, each once', () => {
    expect(create({ reminderDays: [0, 365] }).success).toBe(true);
    expect(messages(create({ reminderDays: [366] }))).toEqual(['validation.reminderDays']);
    expect(messages(create({ reminderDays: [1, 1] }))).toEqual(['validation.duplicate']);
  });
});

describe('UpdateSessionSchema', () => {
  it('should need a change besides the acknowledgement, and allow clearing with null', () => {
    expect(messages(UpdateSessionSchema.safeParse({ acknowledgeConflict: true }))).toEqual([
      'validation.required',
    ]);
    expect(UpdateSessionSchema.parse({ endsAt: null, courtId: null })).toEqual({
      endsAt: null,
      courtId: null,
      acknowledgeConflict: false,
    });
  });
});

describe('SessionOutcomeSchema', () => {
  it('should accept a next session with only its start', () => {
    expect(
      SessionOutcomeSchema.parse({
        outcome: 'ADJOURNED',
        nextSession: { startsAt: '2026-12-01T09:00:00Z' },
      }).nextSession,
    ).toEqual({ startsAt: '2026-12-01T09:00:00Z', acknowledgeConflict: false });
    expect(SessionOutcomeSchema.safeParse({ outcome: 'LOST' }).success).toBe(false);
  });
});

describe('SessionQuerySchema', () => {
  it('should allow up to 92 days and refuse an end before the start', () => {
    const from = '2026-11-01T00:00:00Z';
    expect(SessionQuerySchema.safeParse({ from, to: '2027-02-01T00:00:00Z' }).success).toBe(true);
    expect(messages(SessionQuerySchema.safeParse({ from, to: '2027-02-02T00:00:00Z' }))).toEqual([
      'validation.dateRange',
    ]);
    expect(messages(SessionQuerySchema.safeParse({ from, to: from }))).toEqual([
      'validation.dateRange',
    ]);
    expect(SessionQuerySchema.parse({ lawyerId: 'me' })).toEqual({ lawyerId: 'me' });
  });
});
