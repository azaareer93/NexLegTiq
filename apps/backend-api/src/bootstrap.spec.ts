import { EventEmitter } from 'node:events';

import { API_PREFIX, resolveHost, resolvePort, waitForShutdownSignal } from './bootstrap';

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

  describe('resolveHost', () => {
    it('should default to localhost when HOST is unset or blank', () => {
      expect(resolveHost(undefined)).toBe('localhost');
      expect(resolveHost(' ')).toBe('localhost');
    });

    it('should use HOST when set', () => {
      expect(resolveHost('0.0.0.0')).toBe('0.0.0.0');
    });
  });

  describe('waitForShutdownSignal', () => {
    it.each(['SIGTERM', 'SIGINT'] as const)('should resolve with %s and remove its listeners', async (signal) => {
      // Arrange
      const source = new EventEmitter();
      const pending = waitForShutdownSignal(source);

      // Act
      source.emit(signal);

      // Assert
      await expect(pending).resolves.toBe(signal);
      expect(source.listenerCount('SIGTERM') + source.listenerCount('SIGINT')).toBe(0);
    });
  });
});
