import type { Session } from '@nexlegtiq/shared-contracts';
import dayjs from 'dayjs';

import {
  changesOf,
  conflictsOf,
  createBody,
  formTimes,
  formValuesOf,
  hasStarted,
  pickerValue,
} from './session-form';

const ZONE = 'Asia/Hebron';
const FILE_ID = '01920000-0000-7000-8000-0000000001f1';
const LAWYER = '01920000-0000-7000-8000-0000000000a1';

const SESSION: Session = {
  id: '01920000-0000-7000-8000-0000000005a1',
  file: { id: FILE_ID, fileNumber: '2026-LIT-00007', title: 'Land dispute' },
  sessionType: 'HEARING',
  status: 'SCHEDULED',
  // 09:30 in Hebron (UTC+2 in November).
  startsAt: '2026-11-02T07:30:00.000Z',
  endsAt: null,
  court: { id: '01920000-0000-7000-8000-0000000000d1', nameAr: 'محكمة', nameEn: 'Court' },
  judge: null,
  courtRoom: '3',
  attendingLawyer: { id: LAWYER, fullName: 'Sami Nasser' },
  reminderDays: [7, 1],
  outcome: null,
  minutes: null,
  nextSessionId: null,
  previousSessionId: null,
  cancellationReason: null,
  reminders: [],
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
};

describe('session form (D-127)', () => {
  it('should send the office wall clock with the office offset, whatever the device zone', () => {
    const values = {
      sessionType: 'HEARING' as const,
      date: dayjs('2026-11-02'),
      startsAt: dayjs('2026-11-02T09:30'),
      endsAt: dayjs('2026-11-02T10:15'),
      courtRoom: '  ',
      attendingLawyerId: LAWYER,
      reminderDays: [],
    };
    expect(createBody(values, FILE_ID, ZONE)).toEqual({
      fileId: FILE_ID,
      sessionType: 'HEARING',
      startsAt: '2026-11-02T09:30:00+02:00',
      endsAt: '2026-11-02T10:15:00+02:00',
      attendingLawyerId: LAWYER,
    });
    expect(formTimes({ date: null }, ZONE)).toEqual({});
  });

  it('should show a session on the office clock and send back only what changed', () => {
    const values = formValuesOf(SESSION, ZONE);
    expect(values.startsAt?.format('YYYY-MM-DD HH:mm')).toBe('2026-11-02 09:30');
    expect(changesOf(SESSION, values, ZONE)).toEqual({});
    expect(
      changesOf(
        SESSION,
        {
          ...values,
          startsAt: dayjs('2026-11-02T11:00'),
          courtId: null,
          courtRoom: '',
          reminderDays: [1, 7],
        },
        ZONE,
      ),
    ).toEqual({ startsAt: '2026-11-02T11:00:00+02:00', courtId: null, courtRoom: null });
    expect(
      changesOf(SESSION, { ...values, endsAt: dayjs('2026-11-02T10:00'), reminderDays: [3] }, ZONE),
    ).toEqual({ endsAt: '2026-11-02T10:00:00+02:00', reminderDays: [3] });
    expect(pickerValue('2026-07-01T06:00:00Z', ZONE).format('HH:mm')).toBe('09:00');
  });

  it('should read the busy slots of a 409 BIZ-004 and nothing else', () => {
    const error = {
      code: 'BIZ-004',
      details: [
        {
          field: 'startsAt',
          message: 'validation.sessionConflict',
          params: { sessionId: 's1', startsAt: SESSION.startsAt, endsAt: null, fileNumber: 'F-1' },
        },
        {
          field: 'startsAt',
          message: 'validation.sessionConflict',
          params: { sessionId: null, startsAt: SESSION.startsAt, endsAt: null, fileNumber: null },
        },
        { field: 'startsAt', message: 'x' },
      ],
    };
    expect(conflictsOf(error)).toEqual([
      { sessionId: 's1', startsAt: SESSION.startsAt, fileNumber: 'F-1' },
      { sessionId: null, startsAt: SESSION.startsAt, fileNumber: null },
    ]);
    expect(conflictsOf({ code: 'VAL-001' })).toBeNull();
    expect(conflictsOf(new Error('x'))).toBeNull();
  });

  it('should send each day with the offset it has in the office zone, across the DST change', () => {
    const at = (date: string) =>
      createBody(
        {
          sessionType: 'HEARING',
          date: dayjs(date),
          startsAt: dayjs(`${date}T09:30`),
          attendingLawyerId: LAWYER,
        },
        FILE_ID,
        ZONE,
      ).startsAt;
    // Hebron leaves summer time on 24 October 2026 (D-092).
    expect(at('2026-10-23')).toBe('2026-10-23T09:30:00+03:00');
    expect(at('2026-10-26')).toBe('2026-10-26T09:30:00+02:00');
  });

  it('should tell whether a hearing has started', () => {
    expect(hasStarted(SESSION, Date.parse('2026-11-02T07:30:00Z'))).toBe(true);
    expect(hasStarted(SESSION, Date.parse('2026-11-02T07:29:00Z'))).toBe(false);
  });
});
