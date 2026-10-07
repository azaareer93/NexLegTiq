import type { IncomingMessage, ServerResponse } from 'node:http';

import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Params } from 'nestjs-pino';
import { stdSerializers } from 'pino';

import { AppConfig } from '../../config/app-config';
import { ensureRequestId } from '../context/request-context';
import { routeTemplateOf } from '../http/route-template';
import type { RoutedRequest } from '../http/route-template';

/**
 * Keys never written to logs, at any of the first four nesting levels. Extend this list when a story introduces a new
 * secret-bearing field (API keys D-061, 2FA secrets, IBANs…).
 */
export const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'resetToken',
  'inviteToken',
  'magicToken',
  'idToken',
  'otp',
  'totp',
  'secret',
  'secretAccessKey',
  'pass',
  'DATABASE_URL',
  'REDIS_URL',
  'S3_SECRET_ACCESS_KEY',
  'JWT_SECRET',
  'RESEND_API_KEY',
  'jwtSecret',
  'SMTP_PASSWORD',
  'apiKey',
  'api_key',
  'authorization',
  'Authorization',
  'cookie',
  'nationalId',
  'taxId',
  'iban',
];

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`, `*.*.*.${key}`]),
];

/** Error properties that carry request/response data (body-parser `body`, axios/SDK `config` with API keys…). */
// `command`: ioredis reply errors carry the command's arguments, e.g. a serialized job payload (D-084).
const UNSAFE_ERROR_PROPS = ['body', 'config', 'request', 'response', 'command'];

const QUIET_PATHS = new Set(['/health', '/health/ready']);

type SerializedRequest = Record<string, unknown> & { url?: string; raw?: RoutedRequest };

function pathOf(url: string | undefined): string {
  return (url ?? '').split('?')[0] ?? '';
}

/**
 * Requests are logged by route template when matched (`/api/v1/auth/invites/:token`), otherwise by path without the
 * query string, so tokens in links (reset, invite, magic link) never reach the logs. Query and params are dropped.
 */
export function serializeRequest(req: SerializedRequest): Record<string, unknown> {
  const { raw } = req; // non-enumerable on pino's serialized request
  const template = routeTemplateOf(raw);
  const serialized: Record<string, unknown> = { ...req, url: template ?? pathOf(req.url) };
  delete serialized['query'];
  delete serialized['params'];
  delete serialized['raw'];
  return serialized;
}

export function serializeError(error: Error): Record<string, unknown> {
  const serialized: Record<string, unknown> = { ...stdSerializers.err(error) };
  for (const prop of UNSAFE_ERROR_PROPS) delete serialized[prop];
  return serialized;
}

export function buildLoggerParams(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.log.level,
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      serializers: { req: serializeRequest, err: serializeError },
      genReqId: (req: IncomingMessage, res: ServerResponse) => ensureRequestId(req, res),
      autoLogging: { ignore: (req: IncomingMessage) => QUIET_PATHS.has(pathOf(req.url)) },
      customLogLevel: (_req: IncomingMessage, res: ServerResponse, error?: Error) =>
        error || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      // Bodies are never logged: pino-http does not serialize them, and the serializers above drop error bodies.
      ...(config.log.pretty && {
        transport: { target: 'pino-pretty', options: { singleLine: true } },
      }),
    },
  };
}

@Module({
  imports: [PinoLoggerModule.forRootAsync({ inject: [AppConfig], useFactory: buildLoggerParams })],
})
export class LoggerModule {}
