/**
 * The same normalisation as the SQL function `nlq_normalize_ar` (migration 20260930000000_init, D-059/D-079), so search terms
 * typed in the app match what the database indexes: drop tashkeel (U+064B–065F), the dagger alef (U+0670) and tatweel
 * (U+0640); fold alef forms أ إ آ ٱ → ا, alef maqsura ى → ي, hamza seats ئ → ي and ؤ → و, ta marbuta ة → ه; lower-case.
 * Arabic-Indic digits are left alone. A Postgres integration test checks both on the same fixtures.
 */
export function normalizeArabic(input: string): string {
  return input
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ىئ]/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ة/g, 'ه')
    .toLowerCase();
}
