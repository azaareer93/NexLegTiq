import { Writable } from 'node:stream';

import pino from 'pino';

import { AppConfig } from '../../config/app-config';
import { parseEnv } from '../../config/env.schema';
import { buildLoggerParams, REDACT_PATHS } from './logger.module';

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

  it('should build pino-http params from config', () => {
    const params = buildLoggerParams(new AppConfig(parseEnv({ LOG_LEVEL: 'warn' })));
    const http = params.pinoHttp as { level: string; transport?: unknown };

    expect(http.level).toBe('warn');
    expect(http.transport).toBeUndefined();
  });

  it('should use pino-pretty only when LOG_PRETTY is on', () => {
    const params = buildLoggerParams(new AppConfig(parseEnv({ LOG_PRETTY: 'true' })));

    expect((params.pinoHttp as { transport?: { target: string } }).transport?.target).toBe('pino-pretty');
  });
});
