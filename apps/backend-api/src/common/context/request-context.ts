import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { OfficeId, UserId } from '@nexlegtiq/shared-types';
import type { ClsStore } from 'nestjs-cls';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Which auth realm a request belongs to (office staff, client portal D-003, platform admin). */
export type AuthRealm = 'OFFICE' | 'PORTAL' | 'PLATFORM';

/**
 * Per-request context held in CLS. `requestId` is the CLS id (`ClsService.getId()`); the rest is set by the auth
 * guards (MVP-38/40) and read by services, the tenant extension (MVP-37) and loggers.
 */
export interface RequestContext extends ClsStore {
  userId?: UserId;
  officeId?: OfficeId;
  role?: string;
  permissions?: readonly string[];
  realm?: AuthRealm;
}

// Accept caller-provided ids only if they are short and safe to echo into logs and headers.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

type RequestWithId = IncomingMessage & { id?: unknown };

/**
 * Returns the request id, creating it once: the incoming `x-request-id` when safe, else a new UUID. Idempotent
 * (stored on `req.id`, which pino-http also uses) and mirrored into the response header, so the CLS middleware and
 * the HTTP logger agree whichever runs first.
 */
export function ensureRequestId(req: RequestWithId, res?: ServerResponse): string {
  const id = typeof req.id === 'string' ? req.id : fromHeaderOrNew(req);
  req.id = id;
  if (res && !res.headersSent) res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

function fromHeaderOrNew(req: IncomingMessage): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  return candidate !== undefined && SAFE_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}
