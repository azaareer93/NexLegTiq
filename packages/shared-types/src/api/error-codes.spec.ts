import { ERROR_CODES, isErrorCode } from './error-codes.js';

describe('error codes', () => {
  it('should be unique', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('should all follow the PREFIX-NNN format', () => {
    for (const code of ERROR_CODES) expect(code).toMatch(/^[A-Z]+-\d{3}$/);
  });

  describe('isErrorCode', () => {
    it('should accept a known code', () => {
      expect(isErrorCode('VAL-001')).toBe(true);
    });

    it.each(['VAL-999', 'val-001', 42, undefined])('should reject %s', (value) => {
      expect(isErrorCode(value)).toBe(false);
    });
  });
});
