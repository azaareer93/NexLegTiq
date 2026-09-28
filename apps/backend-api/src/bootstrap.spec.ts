import { API_PREFIX, resolvePort } from './bootstrap';

describe('bootstrap', () => {
  describe('API_PREFIX', () => {
    it('should be versioned under /api/v1 (D-013)', () => {
      expect(API_PREFIX).toBe('api/v1');
    });
  });

  describe('resolvePort', () => {
    it('should default to 3000 when PORT is unset or blank', () => {
      expect(resolvePort(undefined)).toBe(3000);
      expect(resolvePort('  ')).toBe(3000);
    });

    it('should parse a valid port', () => {
      expect(resolvePort('8080')).toBe(8080);
    });

    it.each(['abc', '0', '70000', '30.5'])('should throw when PORT is %s', (raw) => {
      expect(() => resolvePort(raw)).toThrow(/Invalid PORT/);
    });
  });
});
