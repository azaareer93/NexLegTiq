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

  it.each([
    ['no sequence', '{YEAR}-{TYPE}'],
    ['two sequences', '{SEQ}-{SEQ:3}'],
    ['an unknown token', '{YEAR}-{MONTH}-{SEQ}'],
    ['a width out of range', '{SEQ:0}'],
    ['a stray brace', '{YEAR}-{SEQ}}'],
    ['a bidi control', '‮{SEQ}'],
    ['markup', '<b>{SEQ}</b>'],
  ])('should refuse a format with %s', (_case, pattern) => {
    expect(() => parseFileNumberFormat(pattern)).toThrow(RangeError);
  });
});

describe('FILE_TYPE_CODES', () => {
  it('should give every file type its own code', () => {
    expect(Object.keys(FILE_TYPE_CODES).sort()).toEqual(Object.values(FileType).sort());
    expect(new Set(Object.values(FILE_TYPE_CODES)).size).toBe(Object.values(FileType).length);
  });
});
