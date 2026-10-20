import { PiiRedactor } from './pii-redactor';

const redactor = new PiiRedactor();
const NAMES = ['أحمد سالم', 'محمد عليّ', 'Sarah Haddad', 'مؤسسة النور للتجارة', 'Omar bin Khalid'];
const redact = (text: string, names: readonly string[] = NAMES) => redactor.redact(text, { names });

/** [input, the redacted text expected]. Every case also round-trips (see below). */
const CASES: readonly (readonly [string, string])[] = [
  // Names, Arabic: hamza and alef forms, ta marbuta, alef maqsura, marks, tatweel, prefixes, line breaks.
  ['حضر أحمد سالم الجلسة', 'حضر [PARTY_1] الجلسة'],
  ['حضر احمد سالم الجلسة', 'حضر [PARTY_1] الجلسة'],
  ['حضر إحمد سالم', 'حضر [PARTY_1]'],
  ['حضر أَحْمَد سَالِم', 'حضر [PARTY_1]'],
  ['حضر أحـــمد سالم', 'حضر [PARTY_1]'],
  ['وأحمد سالم وكيله', '[PARTY_1] وكيله'.replace('[', 'و[')],
  ['حضر أحمد\nسالم', 'حضر [PARTY_1]'],
  ['قال السيد سالم', 'قال السيد [PARTY_1]'],
  ['عن محمد علي', 'عن [PARTY_1]'],
  ['عن محمد على', 'عن [PARTY_1]'],
  ['لمحمد علي حق', 'ل[PARTY_1] حق'],
  ['مؤسسة النور للتجاره', '[PARTY_1]'],
  ['مؤسسه النور للتجارة', '[PARTY_1]'],
  // Words that only look like a name stay.
  ['السالمي ليس طرفا', 'السالمي ليس طرفا'],
  ['محمدي', 'محمدي'],
  // Names, English: case, spacing, line breaks, particles alone are kept.
  ['Witness Sarah Haddad testified', 'Witness [PARTY_1] testified'],
  ['SARAH  HADDAD signed', '[PARTY_1] signed'],
  ['Ms. Haddad\nreplied', 'Ms. [PARTY_1]\nreplied'],
  ['Omar bin Khalid and Khalid', '[PARTY_1] and [PARTY_2]'],
  ['the bin was empty', 'the bin was empty'],
  ['Haddadi is someone else', 'Haddadi is someone else'],
  // Emails.
  ['write to ahmad.salem@example.ps today', 'write to [EMAIL_1] today'],
  ['البريد: info@nour-trading.co.jo', 'البريد: [EMAIL_1]'],
  // Phones: PS, JO, EG, GCC, international, Arabic-Indic digits, separators.
  ['هاتف 0599123456', 'هاتف [PHONE_1]'],
  ['هاتف 059-912-3456', 'هاتف [PHONE_1]'],
  ['call +970 59 912 3456', 'call [PHONE_1]'],
  ['call 00962-79-123-4567', 'call [PHONE_1]'],
  ['mobile 0791234567', 'mobile [PHONE_1]'],
  ['mobile 01012345678', 'mobile [PHONE_1]'],
  ['جوال +966 50 123 4567', 'جوال [PHONE_1]'],
  ['جوال +971501234567', 'جوال [PHONE_1]'],
  ['هاتف ٠٥٩٩١٢٣٤٥٦', 'هاتف [PHONE_1]'],
  ['office 02-298-7654', 'office [PHONE_1]'],
  // National ids and bank numbers.
  ['هوية رقم 401234567', 'هوية رقم [ID_1]'],
  ['الرقم الوطني 9871234560', 'الرقم الوطني [ID_1]'],
  ['national id 29801011234567', 'national id [ID_1]'],
  ['IBAN PS92PALS000000000400123456702', 'IBAN [IBAN_1]'],
  ['IBAN JO94 CBJO 0010 0000 0000 0131 0003 02', 'IBAN [IBAN_1]'],
  ['card 4111111111111111', 'card [ACCOUNT_1]'],
  // Not PII: dates, amounts, file numbers, years, short numbers.
  ['جلسة 2026-11-02 الساعة 09:30', 'جلسة 2026-11-02 الساعة 09:30'],
  ['المبلغ 12,500.00 شيكل', 'المبلغ 12,500.00 شيكل'],
  [
    'File 2026-LIT-00001, article 12 of law 3/2001',
    'File 2026-LIT-00001, article 12 of law 3/2001',
  ],
];

describe('PiiRedactor (D-057, D-131)', () => {
  it.each(CASES)('should redact %j', (input, expected) => {
    const { text, restore } = redact(input);
    expect(text).toBe(expected);
    // Restoring gives the text back; names come back in the spelling the case uses.
    const back = restore(text);
    expect(redact(back).text).toBe(expected);
  });

  it('should give the same value the same placeholder and count what it replaced', () => {
    const { text, stats, restore } = redact(
      'أحمد سالم (0599123456) وأحمد سالم مرة أخرى، 0599123456، وSarah Haddad.',
    );
    expect(text).toBe('[PARTY_2] ([PHONE_1]) و[PARTY_2] مرة أخرى، [PHONE_1]، و[PARTY_1].');
    expect(stats).toEqual({ PARTY: 3, PHONE: 2 });
    expect(restore('[PARTY_1] called [PARTY_2] on [PHONE_1]; [PARTY_9] stays')).toBe(
      'Sarah Haddad called أحمد سالم on 0599123456; [PARTY_9] stays',
    );
  });

  it('should restore the exact original numbers and emails', () => {
    const input = 'Call +970 59 912 3456 or mail a.salem@example.ps';
    const { text, restore } = redact(input, []);
    expect(text).toBe('Call [PHONE_1] or mail [EMAIL_1]');
    expect(restore(text)).toBe(input);
  });

  it('should ignore empty and one-letter names, and work without any names', () => {
    expect(redact('a b c', ['', ' ', 'a']).text).toBe('a b c');
    expect(redact('نص عادي', []).text).toBe('نص عادي');
  });

  it('should leave text without PII unchanged through redact and restore (property, 500 random texts)', () => {
    // Seeded so a failure is reproducible.
    let seed = 20261021;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const words = [
      'المحكمة',
      'قررت',
      'تأجيل',
      'الجلسة',
      'إلى',
      'موعد',
      'آخر',
      'الدعوى',
      'رقم',
      '2026/15',
      'بتاريخ',
      '12/11/2026',
      'the',
      'court',
      'adjourned',
      'hearing',
      'until',
      'notice',
      'case',
      'article',
      '12',
      '3.5%',
      'ILS',
      '1,250.00',
      '\n',
      '،',
      '.',
      '(',
      ')',
      ':',
      '-',
    ];
    for (let i = 0; i < 500; i += 1) {
      const length = 1 + Math.floor(random() * 40);
      const text = Array.from({ length }, () => words[Math.floor(random() * words.length)]).join(
        random() < 0.2 ? '' : ' ',
      );
      const redacted = redact(text);
      expect(redacted.text).toBe(text);
      expect(redacted.restore(redacted.text)).toBe(text);
    }
  });

  it('should round-trip text with PII written the way the case spells it', () => {
    const input = 'بين أحمد سالم وSarah Haddad، هاتف 0599123456، هوية 401234567، بريد x@y.ps';
    const { text, restore } = redact(input);
    expect(text).not.toMatch(/أحمد|Sarah|0599|4012|x@y/);
    expect(restore(text)).toBe(input);
  });
});
