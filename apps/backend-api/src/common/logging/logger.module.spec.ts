import { Writable } from 'node:stream';

import pino from 'pino';

import { buildLoggerParams, REDACT_PATHS, serializeError, serializeRequest } from './logger.module';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';

function capture(): { stream: Writable; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, output: () => chunks.join('') };
}

describe('logger', () => {
  it('should redact credentials and national ids at nested levels', () => {
    // Arrange
    const { stream, output } = capture();
    const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream);

    // Act
    logger.info({
      password: 'p1',
      user: { token: 't1', profile: { nationalId: '401234567' } },
      req: { headers: { authorization: 'Bearer abc', cookie: 'rt=xyz' } },
    });

    // Assert
    for (const secret of ['p1', 't1', '401234567', 'Bearer abc', 'rt=xyz']) {
      expect(output()).not.toContain(secret);
    }
    expect(output()).toContain('[REDACTED]');
  });

  it('should redact sensitive keys four levels deep and SDK error headers', () => {
    const { stream, output } = capture();
    const logger = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream);

    logger.info({
      a: { b: { c: { password: 'deep-secret' } } },
      err: { config: { headers: { authorization: 'sk-live' } } },
    });

    expect(output()).not.toContain('deep-secret');
    expect(output()).not.toContain('sk-live');
  });

  describe('serializeRequest', () => {
    it('should log the route template and drop query and params (tokens in links)', () => {
      const raw = { baseUrl: '/api/v1', route: { path: '/auth/invites/:token' } };
      const req = Object.defineProperty(
        {
          method: 'GET',
          url: '/api/v1/auth/invites/tok-123?x=1',
          query: { x: '1' },
          params: { token: 'tok-123' },
        },
        'raw',
        { value: raw, enumerable: false },
      );

      const serialized = serializeRequest(req);

      expect(serialized).toEqual({ method: 'GET', url: '/api/v1/auth/invites/:token' });
      expect(JSON.stringify(serialized)).not.toContain('tok-123');
    });

    it('should strip the query string from unmatched URLs', () => {
      expect(serializeRequest({ url: '/api/v1/auth/reset?token=abc123' }).url).toBe(
        '/api/v1/auth/reset',
      );
    });
  });

  it('should drop request/response data from serialized errors', () => {
    const error = Object.assign(new Error('bad json'), {
      body: 'raw body with password',
      config: { headers: { authorization: 'k' } },
    });

    const serialized = serializeError(error);

    expect(serialized).toMatchObject({ type: 'Error', message: 'bad json' });
    expect(serialized).not.toHaveProperty('body');
    expect(serialized).not.toHaveProperty('config');
  });

  it('should log 5xx responses at error and 4xx at warn', () => {
    type LevelFn = (req: unknown, res: { statusCode: number }, err?: Error) => string;
    const params = buildLoggerParams(new AppConfig(parseEnv(testEnv())));
    const level = (params.pinoHttp as { customLogLevel: LevelFn }).customLogLevel;

    expect(level({}, { statusCode: 200 })).toBe('info');
    expect(level({}, { statusCode: 404 })).toBe('warn');
    expect(level({}, { statusCode: 503 })).toBe('error');
    expect(level({}, { statusCode: 200 }, new Error('x'))).toBe('error');
  });

  it('should build pino-http params from config', () => {
    const params = buildLoggerParams(new AppConfig(parseEnv(testEnv({ LOG_LEVEL: 'warn' }))));
    const http = params.pinoHttp as { level: string; transport?: unknown };

    expect(http.level).toBe('warn');
    expect(http.transport).toBeUndefined();
  });

  it('should not auto-log health probes', () => {
    const params = buildLoggerParams(new AppConfig(parseEnv(testEnv())));
    const { ignore } = (
      params.pinoHttp as { autoLogging: { ignore: (req: { url?: string }) => boolean } }
    ).autoLogging;

    expect(ignore({ url: '/health' })).toBe(true);
    expect(ignore({ url: '/health/ready' })).toBe(true);
    expect(ignore({ url: '/health?probe=1' })).toBe(true);
    expect(ignore({ url: '/api/v1/cases' })).toBe(false);
  });

  it('should use pino-pretty only when LOG_PRETTY is on', () => {
    const params = buildLoggerParams(
      new AppConfig(parseEnv(testEnv({ NODE_ENV: 'development', LOG_PRETTY: 'true' }))),
    );

    expect((params.pinoHttp as { transport?: { target: string } }).transport?.target).toBe(
      'pino-pretty',
    );
  });
});
