import { FILE_TYPE_CODES, parseFileNumberFormat } from './file-number';
import { FileType } from '../../generated/prisma/enums';

describe('parseFileNumberFormat', () => {
  it('should render the default format (D-031)', () => {
    const format = parseFileNumberFormat('{YEAR}-{TYPE}-{SEQ:5}');
    expect(format.render({ year: 2026, fileType: 'LITIGATION', seq: 1 })).toBe('2026-LIT-00001');
    expect(format.render({ year: 2026, fileType: 'CRIMINAL', seq: 42 })).toBe('2026-CRM-00042');
    expect(format).toMatchObject({ usesYear: true, usesType: true });
  });

  it('should let a number grow past its padding', () => {
    const format = parseFileNumberFormat('{TYPE}/{SEQ:3}');
    expect(format.render({ year: 2026, fileType: 'NDA_REVIEW', seq: 1234 })).toBe('NDA/1234');
  });

  it.each([
    ['{SEQ}', { usesYear: false, usesType: false }, '7'],
    ['F-{YEAR}-{SEQ:4}', { usesYear: true, usesType: false }, 'F-2026-0007'],
    ['ملف {TYPE} {SEQ:2}', { usesYear: false, usesType: true }, 'ملف CON 07'],
  ])('should say which parts %s uses', (pattern, uses, rendered) => {
    const format = parseFileNumberFormat(pattern);
    expect(format).toMatchObject(uses);
    expect(format.render({ year: 2026, fileType: 'CONTRACT_DRAFTING', seq: 7 })).toBe(rendered);
  });

  it('should keep every allowed literal character and pad up to the width', () => {
    const format = parseFileNumberFormat('No. 7_{YEAR}/#{SEQ:5}-Z');
    expect(format.render({ year: 2026, fileType: 'LITIGATION', seq: 99_999 })).toBe(
      'No. 7_2026/#99999-Z',
    );
    expect(format.render({ year: 2026, fileType: 'LITIGATION', seq: 100_000 })).toBe(
      'No. 7_2026/#100000-Z',
    );
  });

  it.each([
    ['no sequence', '{YEAR}-{TYPE}', /exactly one \{SEQ\}/],
    ['an empty format', '', /exactly one \{SEQ\}/],
    ['two sequences', '{SEQ}-{SEQ:3}', /exactly one \{SEQ\}/],
    ['an unknown token', '{YEAR}-{MONTH}-{SEQ}', /unknown \{MONTH\}/],
    ['a lower-case token', '{seq}', /unknown \{seq\}/],
    ['a width of 0', '{SEQ:0}', /unknown \{SEQ:0\}/],
    ['a width of 10', '{SEQ:10}', /unknown \{SEQ:10\}/],
    ['an empty width', '{SEQ:}', /unknown \{SEQ:\}/],
    ['a stray closing brace', '{YEAR}-{SEQ}}', /unexpected "\}"/],
    ['an unclosed token', '{YEAR}-{SEQ', /unexpected/],
    ['doubled braces', '{{SEQ}}', /unexpected/],
    ['a bidi control', '‮{SEQ}', /unexpected/],
    ['markup', '<b>{SEQ}</b>', /unexpected "<b>"/],
    ['a line break', 'A\n{SEQ}', /unexpected/],
    ['a percent sign', '%{SEQ}', /unexpected/],
    ['a backslash', '\\{SEQ}', /unexpected/],
    ['Arabic-Indic digits (search does not fold them)', '٢٠{SEQ}', /unexpected/],
    ['more than 64 characters', `${'A'.repeat(60)}{SEQ}`, /longer than 64/],
  ])('should refuse a format with %s', (_case, pattern, reason) => {
    expect(() => parseFileNumberFormat(pattern)).toThrow(RangeError);
    expect(() => parseFileNumberFormat(pattern)).toThrow(reason);
  });
});

describe('FILE_TYPE_CODES', () => {
  it('should use the codes of D-031 and D-034', () => {
    expect(FILE_TYPE_CODES).toEqual({
      LITIGATION: 'LIT',
      CRIMINAL: 'CRM',
      CONTRACT_DRAFTING: 'CON',
      LEGAL_ADVISORY: 'ADV',
      COMPLIANCE: 'CMP',
      CONFLICT_RESOLUTION: 'CRS',
      BUSINESS_SUPPORT: 'BUS',
      NDA_REVIEW: 'NDA',
      WILL_TRUST: 'WIL',
      COMPANY_FORMATION: 'INC',
      RENTAL_AGREEMENT: 'RNT',
      EMPLOYMENT_CONTRACT: 'EMP',
    });
  });

  it('should give every file type its own code', () => {
    expect(Object.keys(FILE_TYPE_CODES).sort()).toEqual(Object.values(FileType).sort());
    expect(new Set(Object.values(FILE_TYPE_CODES)).size).toBe(Object.values(FileType).length);
  });
});
