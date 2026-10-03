import type { OfficeId, UserId } from '@nexlegtiq/shared-types';
import type { Request } from 'express';

import type { TenantRunContext } from '../../common/tenancy/tenant-runner';

/** Who is calling, for LoginAttempt rows and audit (D-076: requestId is correlation only). */
export interface ClientInfo {
  readonly ip: string;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

const MAX_USER_AGENT = 512;

/** Audit and token rows store at most 512 characters of the user agent (D-081). */
export function truncateUserAgent(userAgent: string | null): string | null {
  return userAgent === null ? null : userAgent.slice(0, MAX_USER_AGENT);
}

/** TenantRunner context for work done for a user before a request context exists (login, refresh, signup, links). */
export function tenantContextFor(officeId: string, userId: string, client: ClientInfo): TenantRunContext {
  return {
    officeId: officeId as OfficeId,
    userId: userId as UserId,
    ...(client.requestId ? { requestId: client.requestId } : {}),
  };
}

/** Client details of an HTTP request. Behind the proxy chain of TRUST_PROXY_HOPS, so lockout and audit see the real address. */
export function clientFromRequest(req: Request, requestId: string | null): ClientInfo {
  return { ip: req.ip ?? '0.0.0.0', userAgent: req.get('user-agent') ?? null, requestId };
}
