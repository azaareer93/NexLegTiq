import { LocaleSchema } from './locale.contract.js';

describe('LocaleSchema', () => {
  it('should parse a supported locale', () => {
    expect(LocaleSchema.parse('ar')).toBe('ar');
  });

  it('should reject an unsupported locale', () => {
    expect(LocaleSchema.safeParse('fr').success).toBe(false);
  });
});
