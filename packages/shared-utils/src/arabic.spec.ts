import { normalizeArabic } from './arabic.js';

/**
 * The same fixtures as the Postgres test of `nlq_normalize_ar` (apps/backend-api/src/database/database.int.spec.ts),
 * which also checks that the SQL function and `normalizeArabic` agree on each of them.
 */
export const ARABIC_FIXTURES: readonly (readonly [string, string])[] = [
  ['مُحَمَّد', 'محمد'], // tashkeel
  ['محـــمد', 'محمد'], // tatweel
  ['أحمد إبراهيم آمال ٱلقدس', 'احمد ابراهيم امال القدس'], // alef variants
  ['مستشفى', 'مستشفي'], // alef maqsura
  ['محكمة', 'محكمه'], // ta marbuta
  ['مسائل مؤجلة', 'مسايل موجله'], // hamza seats ئ ؤ
  ['Court OF Appeal', 'court of appeal'],
  ['محكمة Appeal ١٢٣', 'محكمه appeal ١٢٣'], // mixed script, Arabic-Indic digits untouched
  ['', ''],
];

describe('normalizeArabic', () => {
  it.each(ARABIC_FIXTURES)('should normalise %s to %s', (input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });

  it('should strip the dagger alef and be idempotent', () => {
    expect(normalizeArabic('هٰذا')).toBe('هذا');
    const once = normalizeArabic('إِبْرَاهِيمُ مُؤَسَّسَة');
    expect(normalizeArabic(once)).toBe(once);
  });
});
