import { COURTS } from '../../prisma/courts.seed';

describe('COURTS seed', () => {
  it('should key every platform court once by jurisdiction and English name, with an Arabic name', () => {
    const keys = COURTS.map((court) => `${court.jurisdiction}:${court.nameEn}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(
      COURTS.filter((court) => court.nameAr.trim() === '' || court.nameEn.trim() === ''),
    ).toEqual([]);
  });
});
