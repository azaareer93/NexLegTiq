/** A wall-clock reading in a time zone: `YYYY-MM-DD` and 24-hour `HH:mm`. */
export interface WallClock {
  readonly date: string;
  readonly time: string;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTE_MS = 60_000;

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

type Parts = Record<'year' | 'month' | 'day' | 'hour' | 'minute', number>;

function parts(instant: number, timeZone: string): Parts {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    partsFormatters.set(timeZone, formatter);
  }
  return Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)]),
  ) as Parts;
}

/** The zone's offset from UTC at an instant, in whole minutes (positive east of Greenwich). */
function offsetMinutes(instant: number, timeZone: string): number {
  const p = parts(instant, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((wall - Math.floor(instant / MINUTE_MS) * MINUTE_MS) / MINUTE_MS);
}

const pad = (value: number) => String(value).padStart(2, '0');

/** What a clock in `timeZone` shows at `value` (an ISO instant or a Date), e.g. to fill a date and a time picker. */
export function wallClock(value: string | Date, timeZone: string): WallClock {
  const instant = typeof value === 'string' ? Date.parse(value) : value.getTime();
  if (Number.isNaN(instant)) throw new RangeError(`Not an instant: ${String(value)}`);
  const p = parts(instant, timeZone);
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

/**
 * The instant a clock in `timeZone` shows `date` `time`, as ISO 8601 with that zone's offset at that moment
 * (`2026-11-02T09:30:00+02:00`) — what the API takes for hearing times (D-116, D-127), whatever the device's own zone.
 * Two passes settle the offset; a wall time skipped or repeated by a DST change (at night) resolves to a neighbouring
 * reading.
 */
export function zonedDateTime(date: string, time: string, timeZone: string): string {
  const d = DATE.exec(date);
  const t = TIME.exec(time);
  if (!d || !t) throw new RangeError(`Not a date and time: ${date} ${time}`);
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  const first = wall - offsetMinutes(wall, timeZone) * MINUTE_MS;
  const instant = wall - offsetMinutes(first, timeZone) * MINUTE_MS;
  const offset = offsetMinutes(instant, timeZone);
  const shown = wallClock(new Date(instant), timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${shown.date}T${shown.time}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
