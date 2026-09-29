import { EventEmitter } from 'node:events';

import { API_PREFIX, waitForShutdownSignal } from './bootstrap';

describe('bootstrap', () => {
  describe('API_PREFIX', () => {
    it('should be versioned under /api/v1 (D-013)', () => {
      expect(API_PREFIX).toBe('api/v1');
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
