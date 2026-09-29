import type { IncomingMessage, ServerResponse } from 'node:http';

import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Params } from 'nestjs-pino';

import { AppConfig } from '../../config/app-config';
import { ensureRequestId } from '../context/request-context';

const SENSITIVE_KEYS = ['password', 'token', 'accessToken', 'refreshToken', 'nationalId', 'secret'];

/** Never log credentials or national ids, at any of the first three nesting levels. */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

const QUIET_PATHS = new Set(['/health', '/health/ready']);

export function buildLoggerParams(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.log.level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      genReqId: (req: IncomingMessage, res: ServerResponse) => ensureRequestId(req, res),
      autoLogging: { ignore: (req: IncomingMessage) => QUIET_PATHS.has(req.url ?? '') },
      // Bodies are never logged (pino-http does not serialize them).
      ...(config.log.pretty && { transport: { target: 'pino-pretty', options: { singleLine: true } } }),
    },
  };
}

@Module({
  imports: [PinoLoggerModule.forRootAsync({ inject: [AppConfig], useFactory: buildLoggerParams })],
})
export class LoggerModule {}
