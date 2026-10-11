import { changes, continuation, effectiveEnd, reminderRows, sessionStatus } from './session-rules';
import type { SessionState } from './session-writer';

const DAY_MS = 86_400_000;

const state = (overrides: Partial<SessionState> = {}): SessionState => ({
  id: 'session',
  fileId: 'file',
  sessionType: 'HEARING',
  startsAt: new Date('2026-11-02T07:00:00Z'),
  endsAt: null,
  courtId: 'court',
  judgeId: 'judge',
  courtRoom: 'Hall 1',
  attendingLawyerId: 'lawyer',
  reminderDays: [7, 3, 1],
  outcome: null,
  minutes: null,
  nextSessionId: null,
  isCancelled: false,
  ...overrides,
});

describe('session rules', () => {
  it('should count one hour for a session without an end', () => {
    const start = new Date('2026-11-02T07:00:00Z');
    expect(effectiveEnd(start, null)).toEqual(new Date('2026-11-02T08:00:00Z'));
    expect(effectiveEnd(start, new Date('2026-11-02T09:30:00Z'))).toEqual(
      new Date('2026-11-02T09:30:00Z'),
    );
  });

  it('should derive the status', () => {
    expect(sessionStatus({ isCancelled: false, outcome: null })).toBe('SCHEDULED');
    expect(sessionStatus({ isCancelled: false, outcome: 'ADJOURNED' })).toBe('COMPLETED');
    expect(sessionStatus({ isCancelled: true, outcome: null })).toBe('CANCELLED');
  });

  it('should plan reminders as whole days before the instant, latest offset first, skipping past ones', () => {
    const startsAt = new Date('2026-10-30T07:00:00Z');
    const now = new Date('2026-10-25T00:00:00Z');
    expect(reminderRows(startsAt, [1, 7, 3], now)).toEqual([
      { daysBefore: 3, scheduledFor: new Date(startsAt.getTime() - 3 * DAY_MS) },
      { daysBefore: 1, scheduledFor: new Date(startsAt.getTime() - DAY_MS) },
    ]);
    expect(reminderRows(startsAt, [], now)).toEqual([]);
  });

  describe('continuation', () => {
    it('should default type, court, judge, room and lawyer to the current session', () => {
      expect(
        continuation(state(), { startsAt: '2026-12-01T07:00:00Z', acknowledgeConflict: false }),
      ).toEqual({
        fileId: 'file',
        sessionType: 'HEARING',
        startsAt: new Date('2026-12-01T07:00:00Z'),
        endsAt: null,
        courtId: 'court',
        judgeId: 'judge',
        courtRoom: 'Hall 1',
        attendingLawyerId: 'lawyer',
        reminderDays: undefined,
        acknowledgeConflict: false,
      });
    });

    it('should drop the judge with another court unless one is given, and take what is sent', () => {
      const next = continuation(state(), {
        startsAt: '2026-12-01T07:00:00Z',
        endsAt: '2026-12-01T08:00:00Z',
        courtId: 'other-court',
        courtRoom: null,
        sessionType: 'APPEAL_HEARING',
        attendingLawyerId: 'lawyer2',
        reminderDays: [2],
        acknowledgeConflict: true,
      });
      expect(next).toMatchObject({
        courtId: 'other-court',
        judgeId: null,
        courtRoom: null,
        sessionType: 'APPEAL_HEARING',
        attendingLawyerId: 'lawyer2',
        endsAt: new Date('2026-12-01T08:00:00Z'),
        reminderDays: [2],
      });
      expect(
        continuation(state(), {
          startsAt: '2026-12-01T07:00:00Z',
          courtId: 'other-court',
          judgeId: 'judge2',
          acknowledgeConflict: false,
        }).judgeId,
      ).toBe('judge2');
    });
  });

  describe('changes', () => {
    it('should keep only real changes: instants by value, day lists as sets', () => {
      expect(
        changes(state(), {
          startsAt: '2026-11-02T09:00:00+02:00', // the same instant
          reminderDays: [1, 3, 7],
          courtRoom: 'Hall 1',
          sessionType: undefined,
        }),
      ).toEqual({ old: {}, next: {} });
    });

    it('should return the old and new values of changed fields', () => {
      expect(
        changes(state(), {
          startsAt: '2026-11-02T08:00:00Z',
          endsAt: '2026-11-02T09:00:00Z',
          courtRoom: null,
          reminderDays: [1],
        }),
      ).toEqual({
        old: {
          startsAt: '2026-11-02T07:00:00.000Z',
          endsAt: null,
          courtRoom: 'Hall 1',
          reminderDays: [7, 3, 1],
        },
        next: {
          startsAt: '2026-11-02T08:00:00Z',
          endsAt: '2026-11-02T09:00:00Z',
          courtRoom: null,
          reminderDays: [1],
        },
      });
    });
  });
});
