import { PiiRedactor } from './pii-redactor';

const redactor = new PiiRedactor();
const PERSONS = [
  'أحمد سالم',
  'محمد عليّ',
  'Sarah-Jane Haddad',
  'Omar bin Khalid',
  'كريم',
  'سامي نصر',
];
const ORGANISATIONS = ['مؤسسة النور للتجارة', 'Al-Masri Trading Co.'];

function redact(text: string, names: readonly string[] = PERSONS, organisations = ORGANISATIONS) {
  const result = redactor.redact([text], { names, organisations });
  return { ...result, text: result.texts[0] ?? '' };
}

const WJ = '⁠';
const ZWJ = '‍';

/** [input, the redacted text expected]. */
const CASES: readonly (readonly [string, string])[] = [
  // Names, Arabic: hamza and alef forms, ta marbuta, alef maqsura, marks, tatweel, prefixes, line breaks, invisibles.
  ['حضر أحمد سالم الجلسة', 'حضر [PARTY_1] الجلسة'],
  ['حضر احمد سالم الجلسة', 'حضر [PARTY_1] الجلسة'],
  ['حضر إحمد سالم', 'حضر [PARTY_1]'],
  ['حضر أَحْمَد سَالِم', 'حضر [PARTY_1]'],
  ['حضر أحـــمد سالم', 'حضر [PARTY_1]'],
  ['وأحمد سالم وكيله', 'و[PARTY_1] وكيله'],
  ['ولأحمد سالم حق', 'ول[PARTY_1] حق'],
  ['حضر أحمد\nسالم', 'حضر [PARTY_1]'],
  [`حضر أح${ZWJ}مد سالم`, 'حضر [PARTY_1]'],
  ['قال السيد سالم', 'قال السيد [PARTY_1]'],
  ['عن محمد علي', 'عن [PARTY_1]'],
  ['عن محمد على', 'عن [PARTY_1]'],
  ['لمحمد علي حق', 'ل[PARTY_1] حق'],
  ['حضر کريم', 'حضر [PARTY_1]'],
  ['حضر سامی نصر', 'حضر [PARTY_1]'],
  // PDF presentation forms are folded (NFKC).
  ['حضر ﺃﺣﻤﺪ ﺳﺎﻟﻢ', 'حضر [PARTY_1]'],
  // Organisations: whole names only; their words stay.
  ['مؤسسة النور للتجاره', '[PARTY_1]'],
  ['مؤسسه النور للتجارة', '[PARTY_1]'],
  ['ليست شركة النور طرفا', 'ليست شركة النور طرفا'],
  ['Al-Masri Trading Co. signed', '[PARTY_1] signed'],
  ['a trading company', 'a trading company'],
  // Words that only look like a name, and common words, stay.
  ['السالمي ليس طرفا', 'السالمي ليس طرفا'],
  ['محمدي', 'محمدي'],
  ['قررت المحكمة على الطلب', 'قررت المحكمة على الطلب'],
  // Names, English: case, hyphens, line breaks, possessive; particles alone stay.
  ['Witness Sarah-Jane Haddad testified', 'Witness [PARTY_1] testified'],
  ['SARAH JANE HADDAD signed', '[PARTY_1] signed'],
  ["Sarah's lawyer and Ms. Haddad\nreplied", "[PARTY_2]'s lawyer and Ms. [PARTY_1]\nreplied"],
  ['Omar bin Khalid and Khalid', '[PARTY_1] and [PARTY_2]'],
  ['the bin was empty', 'the bin was empty'],
  ['Haddadi is someone else', 'Haddadi is someone else'],
  // Emails.
  ['write to ahmad.salem@example.ps today', 'write to [EMAIL_1] today'],
  ['البريد: info@nour-trading.co.jo', 'البريد: [EMAIL_1]'],
  // Phones: PS, JO, EG, GCC, international, Arabic-Indic digits, groupings and separators.
  ['هاتف 0599123456', 'هاتف [PHONE_1]'],
  ['هاتف 059-912-3456', 'هاتف [PHONE_1]'],
  ['هاتف 0599-123-456', 'هاتف [PHONE_1]'],
  ['هاتف 059 - 912 3456', 'هاتف [PHONE_1]'],
  ['call +970 59 912 3456', 'call [PHONE_1]'],
  ['call 00962-79-123-4567', 'call [PHONE_1]'],
  ['mobile 0791234567', 'mobile [PHONE_1]'],
  ['mobile 01012345678', 'mobile [PHONE_1]'],
  ['جوال +966 50 123 4567', 'جوال [PHONE_1]'],
  ['جوال +971501234567', 'جوال [PHONE_1]'],
  ['هاتف ٠٥٩٩١٢٣٤٥٦', 'هاتف [PHONE_1]'],
  ['هاتف ٠٥٩٩ ١٢٣ ٤٥٦', 'هاتف [PHONE_1]'],
  ['office 02-298-7654', 'office [PHONE_1]'],
  ['office (02) 2951234', 'office [PHONE_1]'],
  // National ids and bank numbers, also grouped.
  ['هوية رقم 401234567', 'هوية رقم [ID_1]'],
  ['هوية رقم 4012-3456-7', 'هوية رقم [ID_1]'],
  ['هوية رقم 401 234 567', 'هوية رقم [ID_1]'],
  ['الرقم الوطني 9871234560', 'الرقم الوطني [ID_1]'],
  ['national id 29801011234567', 'national id [ID_1]'],
  ['IBAN PS92PALS000000000400123456702', 'IBAN [IBAN_1]'],
  ['IBAN ps92pals000000000400123456702', 'IBAN [IBAN_1]'],
  ['IBAN JO94 CBJO 0010 0000 0000 0131 0003 02', 'IBAN [IBAN_1]'],
  ['PS92PALS000000000400123456702 TO THE BANK', '[IBAN_1] TO THE BANK'],
  ['card 4111111111111111', 'card [ACCOUNT_1]'],
  ['card 4111 1111 1111 1111', 'card [ACCOUNT_1]'],
  ['card 4111-1111-1111-1111', 'card [ACCOUNT_1]'],
  // Not PII: dates, times, amounts, file numbers, years, short numbers.
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
    // Restoring and redacting again gives the same text (names come back in the spelling the case uses).
    expect(redact(restore(text)).text).toBe(expected);
  });

  it.each(
    CASES.filter(([input]) => !/\p{Script=Arabic}|Sarah|SARAH|Omar|Haddad|Al-Masri/u.test(input)),
  )('should restore %j exactly when it holds no names', (input) => {
    const { text, restore } = redact(input);
    expect(restore(text)).toBe(input.normalize('NFKC'));
  });

  it('should number across the texts of one call, so one placeholder is one person everywhere', () => {
    const { texts, stats, restore } = redactor.redact(
      [
        'The file concerns Sarah-Jane Haddad.',
        'أحمد سالم (0599123456) وأحمد سالم، 0599123456، وSarah-Jane Haddad.',
      ],
      { names: PERSONS },
    );
    expect(texts).toEqual([
      'The file concerns [PARTY_1].',
      '[PARTY_2] ([PHONE_1]) و[PARTY_2]، [PHONE_1]، و[PARTY_1].',
    ]);
    expect(stats).toEqual({ PARTY: 4, PHONE: 2 });
    expect(restore('[PARTY_1] called [PARTY_2] on [PHONE_1]; [PARTY_9] stays')).toBe(
      'Sarah-Jane Haddad called أحمد سالم on 0599123456; [PARTY_9] stays',
    );
  });

  it('should not let a placeholder-looking token of the source turn into a value', () => {
    const { text, restore } = redact('The note says [PARTY_1] and Sarah-Jane Haddad.');
    expect(text).toBe(`The note says [PARTY${WJ}_1] and [PARTY_1].`);
    expect(restore(text)).toBe(`The note says [PARTY${WJ}_1] and Sarah-Jane Haddad.`);
  });

  it('should keep placeholders intact when a person is called like one ("Phone")', () => {
    const { text, restore } = redact('رقم 0599123456 للسيد Phone Ali', ['Phone Ali']);
    expect(text).toBe('رقم [PHONE_1] للسيد [PARTY_1]');
    expect(restore(text)).toBe('رقم 0599123456 للسيد Phone Ali');
  });

  it('should ignore empty and one-letter names, and work without any names', () => {
    expect(redact('a b c', ['', ' ', 'a'], []).text).toBe('a b c');
    expect(redact('نص عادي', [], []).text).toBe('نص عادي');
  });

  it('should stay linear on the longest input allowed (400,000 characters)', () => {
    for (const filler of ['a', 'ab.', '1', 'أ ب ']) {
      const text = filler.repeat(Math.ceil(400_000 / filler.length)).slice(0, 400_000);
      const started = Date.now();
      redact(text);
      expect(Date.now() - started).toBeLessThan(3000);
    }
  });

  it('should restore any text, PII mixed in, and send none of the PII (property, 500 random texts)', () => {
    // A seeded 32-bit generator: a failure is reproducible.
    let seed = 20261021;
    const random = () => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const words = [
      'المحكمة',
      'قررت',
      'تأجيل',
      'الجلسة',
      'إلى',
      'على',
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
    const pii = [
      'أحمد سالم',
      'Sarah-Jane Haddad',
      '0599123456',
      '+970 59 912 3456',
      'a.salem@example.ps',
      '401234567',
    ];
    for (let i = 0; i < 500; i += 1) {
      const length = 1 + Math.floor(random() * 40);
      const parts = Array.from({ length }, () => (random() < 0.15 ? pick(pii) : pick(words)));
      const text = parts.join(' ');
      const redacted = redact(text);
      expect(redacted.restore(redacted.text)).toBe(text);
      for (const value of pii) expect(redacted.text).not.toContain(value);
    }
  });
});
