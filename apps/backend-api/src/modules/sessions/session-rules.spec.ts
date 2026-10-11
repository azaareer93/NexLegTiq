import {
  changes,
  continuation,
  durationProblem,
  effectiveEnd,
  nextSlot,
  reminderRows,
  sessionStatus,
  slotChanges,
  updatedPayload,
} from './session-rules';
import type { SessionState } from './session-writer';

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
  file: { status: 'OPEN', deletedAt: null },
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

  describe('reminderRows', () => {
    const tz = 'Asia/Hebron';
    // Hebron is UTC+2 in winter, UTC+3 in summer (DST ends 24 October 2026).
    const startsAt = new Date('2026-11-12T08:30:00Z'); // 10:30 in Hebron

    it('should be due at 09:00 office time N calendar days before the hearing', () => {
      const now = new Date('2026-10-01T00:00:00Z');
      expect(reminderRows(startsAt, [1, 7, 3], now, tz)).toEqual([
        { daysBefore: 7, scheduledFor: new Date('2026-11-05T07:00:00Z') },
        { daysBefore: 3, scheduledFor: new Date('2026-11-09T07:00:00Z') },
        { daysBefore: 1, scheduledFor: new Date('2026-11-11T07:00:00Z') },
      ]);
      expect(reminderRows(startsAt, [], now, tz)).toEqual([]);
    });

    it('should follow the zone across a DST change', () => {
      // 30 October 10:30 local is after the change; 7 days earlier is still summer time (09:00 = 06:00Z).
      const now = new Date('2026-10-01T00:00:00Z');
      expect(reminderRows(new Date('2026-10-30T08:30:00Z'), [7, 0], now, tz)).toEqual([
        { daysBefore: 7, scheduledFor: new Date('2026-10-23T06:00:00Z') },
        { daysBefore: 0, scheduledFor: new Date('2026-10-30T07:00:00Z') },
      ]);
    });

    it('should use the local date of the hearing, not the UTC one', () => {
      // 00:30 on 12 November in Hebron is still 11 November in UTC.
      const lateNight = new Date('2026-11-11T22:30:00Z');
      expect(reminderRows(lateNight, [1], new Date('2026-10-01T00:00:00Z'), tz)).toEqual([
        { daysBefore: 1, scheduledFor: new Date('2026-11-11T07:00:00Z') },
      ]);
    });

    it('should collapse reminders already due into one due now, while the hearing is ahead', () => {
      const now = new Date('2026-11-10T12:00:00Z');
      expect(reminderRows(startsAt, [7, 3, 1], now, tz)).toEqual([
        { daysBefore: 3, scheduledFor: now },
        { daysBefore: 1, scheduledFor: new Date('2026-11-11T07:00:00Z') },
      ]);
      expect(reminderRows(startsAt, [7, 3, 1], startsAt, tz)).toEqual([]);
    });

    it('should drop a reminder due after the hearing has started', () => {
      const early = new Date('2026-11-12T06:00:00Z'); // 08:00 in Hebron, before the 09:00 same-day reminder
      expect(reminderRows(early, [0], new Date('2026-11-01T00:00:00Z'), tz)).toEqual([]);
    });
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

  it('should accept an end after the start, by at most 24 hours', () => {
    const start = new Date('2026-11-02T07:00:00Z');
    expect(durationProblem(start, null)).toBeNull();
    expect(durationProblem(start, new Date('2026-11-03T07:00:00Z'))).toBeNull();
    expect(durationProblem(start, start)).toBe('validation.endsBeforeStart');
    expect(durationProblem(start, new Date('2026-11-03T07:00:01Z'))).toBe(
      'validation.sessionTooLong',
    );
  });

  it('should build the slot after a PATCH and write only the slot fields it changed', () => {
    const slot = nextSlot(state(), {
      endsAt: '2026-11-02T08:00:00Z',
      acknowledgeConflict: false,
    });
    expect(slot).toEqual({
      startsAt: new Date('2026-11-02T07:00:00Z'),
      endsAt: new Date('2026-11-02T08:00:00Z'),
      attendingLawyerId: 'lawyer',
    });
    expect(slotChanges(slot, { endsAt: 'x', courtRoom: 'y' })).toEqual({
      endsAt: new Date('2026-11-02T08:00:00Z'),
    });
    expect(() =>
      nextSlot(state(), { endsAt: '2026-11-02T06:00:00Z', acknowledgeConflict: false }),
    ).toThrow();
  });

  it('should name the previous start in the timeline only when the session moved', () => {
    const moved = {
      startsAt: new Date('2026-11-03T07:00:00Z'),
      endsAt: null,
      attendingLawyerId: 'l',
    };
    expect(updatedPayload(state(), { acknowledgeConflict: false }, moved)).toEqual({
      change: 'UPDATED',
      sessionType: 'HEARING',
      startsAt: '2026-11-03T07:00:00.000Z',
      previousStartsAt: '2026-11-02T07:00:00.000Z',
    });
    const same = { ...moved, startsAt: new Date('2026-11-02T07:00:00Z') };
    expect(updatedPayload(state(), { acknowledgeConflict: false }, same)).not.toHaveProperty(
      'previousStartsAt',
    );
  });
});
