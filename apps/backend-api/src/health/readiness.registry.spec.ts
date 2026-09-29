import type { PinoLogger } from 'nestjs-pino';

import { ReadinessRegistry } from './readiness.registry';

function createRegistry(): { registry: ReadinessRegistry; warn: jest.Mock } {
  const warn = jest.fn();
  const logger = { setContext: jest.fn(), warn } as unknown as PinoLogger;
  return { registry: new ReadinessRegistry(logger), warn };
}

describe('ReadinessRegistry', () => {
  it('should be ok with no checks registered', async () => {
    const { registry } = createRegistry();

    await expect(registry.run()).resolves.toEqual({ status: 'ok', checks: {} });
  });

  it('should report each check and be ok when all pass', async () => {
    const { registry } = createRegistry();
    registry.register('db', () => Promise.resolve());

    const report = await registry.run();

    expect(report.status).toBe('ok');
    expect(report.checks['db']).toEqual({ status: 'up', durationMs: expect.any(Number) });
  });

  it('should be error and log the reason when a check rejects', async () => {
    const { registry, warn } = createRegistry();
    registry.register('db', () => Promise.resolve());
    registry.register('redis', () => Promise.reject(new Error('refused')));

    const report = await registry.run();

    expect(report.status).toBe('error');
    expect(report.checks['redis']?.status).toBe('down');
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ check: 'redis' }), 'Readiness check failed');
  });

  it('should mark a check down when it exceeds the timeout', async () => {
    jest.useFakeTimers();
    try {
      const { registry } = createRegistry();
      registry.register('storage', () => new Promise(() => undefined));

      const pending = registry.run(50);
      await jest.advanceTimersByTimeAsync(50);

      expect((await pending).checks['storage']?.status).toBe('down');
    } finally {
      jest.useRealTimers();
    }
  });

  it('should reject duplicate names', () => {
    const { registry } = createRegistry();
    registry.register('db', () => Promise.resolve());

    expect(() => registry.register('db', () => Promise.resolve())).toThrow(/already registered/);
    expect(registry.names()).toEqual(['db']);
  });
});
