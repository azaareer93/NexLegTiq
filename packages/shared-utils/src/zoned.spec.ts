import { wallClock, zonedDateTime } from './zoned.js';

describe('zonedDateTime', () => {
  it.each([
    ['2026-11-02', '09:30', 'Asia/Hebron', '2026-11-02T09:30:00+02:00'],
    ['2026-07-01', '09:30', 'Asia/Hebron', '2026-07-01T09:30:00+03:00'],
    ['2026-01-15', '00:00', 'UTC', '2026-01-15T00:00:00+00:00'],
    ['2026-01-15', '23:45', 'America/New_York', '2026-01-15T23:45:00-05:00'],
    ['2026-07-01', '08:15', 'Asia/Kolkata', '2026-07-01T08:15:00+05:30'],
  ])('should read %s %s in %s as %s', (date, time, zone, expected) => {
    expect(zonedDateTime(date, time, zone)).toBe(expected);
    expect(Date.parse(zonedDateTime(date, time, zone))).toBe(Date.parse(expected));
  });

  it('should take the earlier reading of a repeated hour and stay within an hour in a skipped one', () => {
    expect(zonedDateTime('2026-11-01', '01:30', 'America/New_York')).toBe(
      '2026-11-01T01:30:00-04:00',
    );
    const gap = Date.parse(zonedDateTime('2026-03-08', '02:30', 'America/New_York'));
    expect(Math.abs(gap - Date.parse('2026-03-08T02:30:00-05:00'))).toBeLessThanOrEqual(3_600_000);
  });

  it('should refuse anything but YYYY-MM-DD and HH:mm', () => {
    expect(() => zonedDateTime('2026-1-2', '09:30', 'UTC')).toThrow(RangeError);
    expect(() => zonedDateTime('2026-01-02', '24:00', 'UTC')).toThrow(RangeError);
  });
});

describe('wallClock', () => {
  it('should show an instant on the clock of a zone, from a string or a Date', () => {
    expect(wallClock('2026-11-02T07:30:00Z', 'Asia/Hebron')).toEqual({
      date: '2026-11-02',
      time: '09:30',
    });
    expect(wallClock(new Date('2026-12-31T22:30:00Z'), 'Asia/Hebron')).toEqual({
      date: '2027-01-01',
      time: '00:30',
    });
    expect(() => wallClock('not a date', 'UTC')).toThrow(RangeError);
  });

  it('should round-trip with zonedDateTime', () => {
    const iso = zonedDateTime('2026-10-24', '18:05', 'Asia/Hebron');
    expect(wallClock(iso, 'Asia/Hebron')).toEqual({ date: '2026-10-24', time: '18:05' });
  });
});
