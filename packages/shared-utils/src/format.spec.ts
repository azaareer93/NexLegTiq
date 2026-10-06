import {
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatRelative,
  formatTime,
  toArabicIndicDigits,
  toWesternDigits,
} from './format.js';

// Intl wraps Arabic currency and signs in bidi marks (RLM U+200F, LRM U+200E); they are part of correct output.
const RLM = '\u200F';
const LRM = '\u200E';
// …and keeps amount and currency together with a no-break space (U+00A0).
const NBSP = '\u00A0';
const AT = '2026-10-13T12:05:00Z'; // 15:05 in Hebron (UTC+3, summer time)

describe('formatDate', () => {
  it.each([
    ['ar', 'latn', '13/10/2026'],
    ['en', 'latn', '13/10/2026'],
    ['ar', 'arab', '١٣/١٠/٢٠٢٦'],
  ] as const)('should write dd/MM/yyyy in %s with %s digits', (locale, digits, expected) => {
    expect(formatDate(AT, { locale, digits })).toBe(expected);
  });

  it.each([
    ['ar', '13 أكتوبر 2026'],
    ['en', '13 October 2026'],
  ] as const)(
    'should spell the month in %s, MSA month names in Arabic (D-092)',
    (locale, expected) => {
      expect(formatDate(AT, { locale, style: 'long' })).toBe(expected);
    },
  );

  it('should show the date in the given time zone, not the device one: late evening UTC is the next day in Hebron', () => {
    expect(formatDate('2026-10-13T21:30:00Z', { locale: 'en' })).toBe('14/10/2026');
    expect(formatDate('2026-10-13T21:30:00Z', { locale: 'en', timeZone: 'UTC' })).toBe(
      '13/10/2026',
    );
  });

  it('should show a date-only value (a deadline) as written, in any zone', () => {
    expect(formatDate('2026-10-13', { locale: 'en', timeZone: 'America/New_York' })).toBe(
      '13/10/2026',
    );
    expect(formatDate('2026-10-13', { locale: 'en', timeZone: 'Asia/Hebron', style: 'long' })).toBe(
      '13 October 2026',
    );
  });

  it('should accept a Date, an ISO string and a timestamp alike', () => {
    const date = new Date(AT);
    expect([
      formatDate(date, { locale: 'en' }),
      formatDate(AT, { locale: 'en' }),
      formatDate(date.getTime(), { locale: 'en' }),
    ]).toEqual(['13/10/2026', '13/10/2026', '13/10/2026']);
  });

  it('should refuse an invalid date instead of printing "Invalid Date"', () => {
    expect(() => formatDate('not a date', { locale: 'en' })).toThrow(RangeError);
  });
});

describe('formatTime and formatDateTime', () => {
  it.each([
    ['ar', 'latn', '3:05 م'],
    ['ar', 'arab', '٣:٠٥ م'],
    ['en', 'latn', '3:05 PM'],
  ] as const)(
    'should write the time in %s (%s digits), with ص/م in Arabic',
    (locale, digits, expected) => {
      expect(formatTime(AT, { locale, digits })).toBe(expected);
    },
  );

  it.each([
    ['ar', '13/10/2026 3:05 م'],
    ['en', '13/10/2026 3:05 PM'],
  ] as const)('should combine date and time in %s', (locale, expected) => {
    expect(formatDateTime(AT, { locale })).toBe(expected);
  });

  // Asia/Hebron in 2026, per the tz database shipped with ICU: summer time starts on 28 March (02:00 → 03:00) and ends on
  // 24 October (02:00 → 01:00). Palestine sets these dates by decree, so a tzdata update may move them: update the fixtures.
  it.each([
    ['before spring forward', '2026-03-27T21:30:00Z', '27/03/2026 11:30 PM'],
    ['after spring forward', '2026-03-28T00:30:00Z', '28/03/2026 3:30 AM'],
    ['before fall back', '2026-10-23T21:30:00Z', '24/10/2026 12:30 AM'],
    ['after fall back', '2026-10-24T00:30:00Z', '24/10/2026 2:30 AM'],
  ])('should follow Hebron summer time %s', (_case, iso, expected) => {
    expect(formatDateTime(iso, { locale: 'en', timeZone: 'Asia/Hebron' })).toBe(expected);
  });

  it('should show both occurrences of the repeated hour when summer time ends', () => {
    expect(formatTime('2026-10-23T22:30:00Z', { locale: 'en' })).toBe('1:30 AM'); // summer time (UTC+3)
    expect(formatTime('2026-10-23T23:30:00Z', { locale: 'en' })).toBe('1:30 AM'); // winter time (UTC+2), an hour later
  });

  it('should refuse a date and time without a zone, which each machine would read differently', () => {
    expect(() => formatDateTime('2026-03-28T02:30:00', { locale: 'en' })).toThrow(RangeError);
    expect(() => formatTime('2026-03-28T02:30', { locale: 'en' })).toThrow(RangeError);
    expect(formatTime('2026-03-28T02:30:00+02:00', { locale: 'en' })).toBe('3:30 AM'); // 02:30 does not exist that night
  });

  it('should keep two instants an hour apart across the spring change three hours apart on the clock', () => {
    expect(formatTime('2026-03-27T23:30:00Z', { locale: 'en' })).toBe('1:30 AM');
    expect(formatTime('2026-03-28T00:30:00Z', { locale: 'en' })).toBe('3:30 AM');
  });
});

describe('formatRelative', () => {
  const ago = (milliseconds: number) => new Date(Date.parse(AT) - milliseconds);
  const DAY = 86_400_000;

  it.each([
    [3 * DAY, 'ar', 'قبل 3 أيام'],
    [2 * DAY, 'ar', 'أول أمس'],
    [DAY, 'ar', 'أمس'],
    [-DAY, 'ar', 'غدًا'],
    [2 * 3_600_000, 'ar', 'قبل ساعتين'],
    [20_000, 'ar', 'الآن'],
    [-35 * DAY, 'ar', 'خلال 5 أسابيع'],
    [-90 * DAY, 'ar', 'خلال 3 أشهر'],
    [-2 * 7 * DAY, 'ar', 'خلال أسبوعين'],
    [-11 * DAY, 'ar', 'خلال 11 يومًا'],
    [11 * DAY, 'ar', 'قبل 11 يومًا'],
    [2 * 60_000, 'ar', 'قبل دقيقتين'],
    [2 * 365 * DAY, 'ar', 'قبل سنتين'],
    [10 * DAY, 'en', '10 days ago'],
    [3 * DAY, 'en', '3 days ago'],
    [DAY, 'en', 'yesterday'],
    [-DAY, 'en', 'tomorrow'],
    [5 * 60_000, 'en', '5 minutes ago'],
    [2 * 7 * DAY, 'en', '2 weeks ago'],
    [400 * DAY, 'en', 'last year'],
    [20_000, 'en', 'now'],
  ] as const)('should describe %i ms ago in %s as %s', (milliseconds, locale, expected) => {
    expect(formatRelative(ago(milliseconds), { locale, now: AT })).toBe(expected);
  });

  it('should count calendar days in the user zone, not 24-hour spans', () => {
    // Seen at 17:00 in Hebron: a hearing at 05:00 the day after tomorrow is 36 h away but two calendar days.
    const now = '2026-10-13T14:00:00Z';
    expect(formatRelative('2026-10-15T02:00:00Z', { locale: 'ar', now })).toBe('بعد الغد');
    expect(formatRelative('2026-10-15T02:00:00Z', { locale: 'en', now })).toBe('in 2 days');
    // Tomorrow at 09:00 is "tomorrow", although only 16 hours away.
    expect(formatRelative('2026-10-14T06:00:00Z', { locale: 'en', now })).toBe('tomorrow');
    // Yesterday evening, 20 hours ago across midnight, is "yesterday", not "20 hours ago".
    expect(formatRelative('2026-10-12T18:00:00Z', { locale: 'en', now })).toBe('yesterday');
    // The same instants in UTC fall on other calendar days.
    expect(
      formatRelative('2026-10-12T22:30:00Z', {
        locale: 'en',
        now: '2026-10-13T00:30:00Z',
        timeZone: 'UTC',
      }),
    ).toBe('yesterday');
    expect(
      formatRelative('2026-10-12T22:30:00Z', { locale: 'en', now: '2026-10-13T00:30:00Z' }),
    ).toBe('2 hours ago');
  });

  it('should use Arabic-Indic digits when preferred', () => {
    expect(formatRelative(ago(3 * DAY), { locale: 'ar', now: AT, digits: 'arab' })).toBe(
      'قبل ٣ أيام',
    );
  });

  it('should measure from the current time by default', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(AT));
    try {
      expect(formatRelative(AT, { locale: 'en' })).toBe('now');
      expect(formatRelative('2026-10-13T12:04:00Z', { locale: 'en' })).toBe('1 minute ago');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatNumber', () => {
  it.each([
    ['1234567.891', 'ar', 'latn', '1,234,567.891'],
    [1234.5, 'ar', 'arab', '١٬٢٣٤٫٥'],
    ['1234.5', 'en', 'latn', '1,234.5'],
    // Exact decimal strings, rounded half-even: no float error (0.125 would be 0.13 half-up).
    ['0.125', 'en', 'latn', '0.12'],
    ['0.135', 'en', 'latn', '0.14'],
  ] as const)('should write %s in %s with %s digits as %s', (value, locale, digits, expected) => {
    expect(
      formatNumber(value, {
        locale,
        digits,
        maximumFractionDigits: typeof value === 'string' && value.startsWith('0.1') ? 2 : 3,
      }),
    ).toBe(expected);
  });

  it('should allow three decimals unless told otherwise', () => {
    expect(formatNumber('1.23456', { locale: 'en' })).toBe('1.235');
  });

  it('should refuse values that are not numbers, and never print -0', () => {
    expect(() => formatNumber(Number.NaN, { locale: 'en' })).toThrow(RangeError);
    expect(() => formatNumber(Number.POSITIVE_INFINITY, { locale: 'en' })).toThrow(RangeError);
    expect(() => formatNumber('abc', { locale: 'en' })).toThrow(RangeError);
    expect(formatNumber('-0.0004', { locale: 'en' })).toBe('0');
    expect(formatNumber(-1.5, { locale: 'en' })).toBe('-1.5');
  });

  it('should keep a precision a float would lose', () => {
    expect(formatNumber('12345678901234567.25', { locale: 'en', maximumFractionDigits: 2 })).toBe(
      '12,345,678,901,234,567.25',
    );
  });
});

describe('formatMoney', () => {
  it.each([
    ['1234.5', 'ILS', 'ar', 'latn', `${RLM}1,234.50${NBSP}₪`],
    ['1234.5', 'ILS', 'en', 'latn', '₪1,234.50'],
    ['1234.5', 'JOD', 'ar', 'latn', `${RLM}1,234.500${NBSP}د.أ.${RLM}`],
    ['1234.5', 'JOD', 'en', 'latn', `JOD${NBSP}1,234.500`],
    ['1000', 'EGP', 'ar', 'latn', `${RLM}1,000.00${NBSP}ج.م.${RLM}`],
    ['1234.5', 'SAR', 'ar', 'arab', `${RLM}١٬٢٣٤٫٥٠${NBSP}ر.س.${RLM}`],
    ['1000', 'AED', 'en', 'latn', `AED${NBSP}1,000.00`],
    ['1000', 'USD', 'en', 'latn', '$1,000.00'],
    ['-50', 'USD', 'ar', 'latn', `${RLM}${LRM}-50.00${NBSP}US$`],
  ] as const)(
    'should write %s %s in %s (%s digits)',
    (amount, currency, locale, digits, expected) => {
      expect(formatMoney(amount, currency, { locale, digits })).toBe(expected);
    },
  );

  it.each([
    ['0.125', '$0.12'],
    ['0.135', '$0.14'],
    ['99.995', '$100.00'],
    ['2.675', '$2.68'], // 2.675 as a float is 2.67499…: exact decimals round it correctly
  ])('should round %s half-even to the currency digits', (amount, expected) => {
    expect(formatMoney(amount, 'USD', { locale: 'en' })).toBe(expected);
  });

  it.each(['12,5', 'NaN', 'Infinity', '0x10', '1e200000000', ' 1', ''])(
    'should refuse %j as an amount (and never hang on it)',
    (amount) => {
      expect(() => formatMoney(amount, 'USD', { locale: 'en' })).toThrow(RangeError);
    },
  );

  it('should refuse an unknown currency instead of guessing its decimals', () => {
    expect(() => formatMoney('1', 'XYZ', { locale: 'en' })).toThrow(RangeError);
  });

  it('should round JOD half-even to its three decimals, and show zero plainly', () => {
    expect(formatMoney('1.2345', 'JOD', { locale: 'en' })).toBe(`JOD${NBSP}1.234`);
    expect(formatMoney('1.2355', 'JOD', { locale: 'en' })).toBe(`JOD${NBSP}1.236`);
    expect(formatMoney('0', 'USD', { locale: 'en' })).toBe('$0.00');
    expect(formatMoney('-0', 'USD', { locale: 'en' })).toBe('$0.00');
  });

  it('should never show a negative zero, and keep real negatives', () => {
    expect(formatMoney('-0.001', 'USD', { locale: 'en' })).toBe('$0.00');
    expect(formatMoney('-0.004', 'ILS', { locale: 'ar' })).toBe(`${RLM}0.00${NBSP}₪`);
    expect(formatMoney('-1234.5', 'ILS', { locale: 'en' })).toBe('-₪1,234.50');
  });
});

describe('digit conversion', () => {
  it('should convert between Western and Arabic-Indic digits, leaving other text alone', () => {
    expect(toArabicIndicDigits('2026-LIT-00042')).toBe('٢٠٢٦-LIT-٠٠٠٤٢');
    expect(toWesternDigits('٢٠٢٦-LIT-٠٠٠٤٢')).toBe('2026-LIT-00042');
    expect(toWesternDigits('۱۲۳')).toBe('123'); // Persian digits, as some keyboards type them
    expect(toWesternDigits('١٬٢٣٤٫٥٠')).toBe('1234.50'); // Arabic thousands and decimal separators
  });
});
