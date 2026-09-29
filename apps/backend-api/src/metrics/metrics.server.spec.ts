import type { PinoLogger } from 'nestjs-pino';
import request from 'supertest';

import { AppConfig } from '../config/app-config';
import { parseEnv } from '../config/env.schema';
import { MetricsServer } from './metrics.server';
import { MetricsService } from './metrics.service';

function createServer(env: Record<string, string> = {}): MetricsServer {
  const logger = { setContext: jest.fn(), info: jest.fn() } as unknown as PinoLogger;
  return new MetricsServer(new MetricsService(), new AppConfig(parseEnv(env)), logger);
}

describe('MetricsServer', () => {
  it('should serve Prometheus metrics on its own port and 404 anything else', async () => {
    // Arrange
    const server = createServer();
    const address = await server.start('127.0.0.1', 0);
    const base = `http://127.0.0.1:${address.port}`;

    try {
      // Act
      const metrics = await request(base).get('/metrics');
      const other = await request(base).get('/api/v1/anything');

      // Assert
      expect(metrics.status).toBe(200);
      expect(metrics.headers['content-type']).toContain('text/plain');
      expect(metrics.text).toContain('process_cpu_user_seconds_total');
      expect(metrics.text).toContain('# TYPE http_request_duration_seconds histogram');
      expect(other.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  it('should start on bootstrap when enabled and stop on shutdown', async () => {
    const server = createServer({ METRICS_HOST: '127.0.0.1', METRICS_PORT: '1' });
    const start = jest.spyOn(server, 'start').mockResolvedValue({ address: '127.0.0.1', family: 'IPv4', port: 1 });
    const stop = jest.spyOn(server, 'stop');

    await server.onApplicationBootstrap();
    await server.onApplicationShutdown();

    expect(start).toHaveBeenCalledWith('127.0.0.1', 1);
    expect(stop).toHaveBeenCalled();
  });

  it('should reject when the port is already in use', async () => {
    const first = createServer();
    const second = createServer();
    const { port } = await first.start('127.0.0.1', 0);

    try {
      await expect(second.start('127.0.0.1', port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await first.stop();
    }
  });

  it('should resolve stop() when it was never started', async () => {
    await expect(createServer().stop()).resolves.toBeUndefined();
  });

  it('should not listen when metrics are disabled', async () => {
    const server = createServer({ METRICS_ENABLED: 'false' });
    const start = jest.spyOn(server, 'start');

    await server.onApplicationBootstrap();

    expect(start).not.toHaveBeenCalled();
    await server.onApplicationShutdown();
  });
});
