import { textDirectionOf } from './direction.js';

describe('textDirectionOf', () => {
  it('should be rtl for Arabic', () => {
    expect(textDirectionOf('ar')).toBe('rtl');
  });

  it('should be ltr for English', () => {
    expect(textDirectionOf('en')).toBe('ltr');
  });
});
