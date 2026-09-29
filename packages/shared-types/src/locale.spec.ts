import { isLocale, SUPPORTED_LOCALES } from './locale.js';

describe('locale', () => {
  it('should support exactly Arabic and English', () => {
    expect(SUPPORTED_LOCALES).toEqual(['ar', 'en']);
  });

  describe('isLocale', () => {
    it.each(['ar', 'en'])('should accept %s', (value) => {
      expect(isLocale(value)).toBe(true);
    });

    it.each(['fr', 'AR', '', null, 1])('should reject %s', (value) => {
      expect(isLocale(value)).toBe(false);
    });
  });
});
