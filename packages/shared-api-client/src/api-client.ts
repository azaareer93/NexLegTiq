import axios from 'axios';
import type { AxiosResponse } from 'axios';
import type { z } from 'zod';

import { buildApiUrl } from './api-url.js';
import { ApiError, REQUEST_ID_HEADER, toApiError } from './api-error.js';

export type Realm = 'office' | 'portal' | 'admin';

/** Each realm has its own refresh cookie and endpoint (D-003, auth-rbac.md). */
const REFRESH_PATH: Record<Realm, string> = {
  office: 'auth/refresh',
  portal: 'portal/auth/refresh',
  admin: 'admin/auth/refresh',
};

export const REQUEST_TIMEOUT_MS = 30_000;

export interface ApiClientConfig {
  /** API origin, e.g. `https://api.nexlegtiq.com`; `/api/v1` is added. */
  readonly baseURL: string;
  readonly realm: Realm;
  /** The access token lives in memory only (a Zustand store, never storage — D-050). */
  readonly getToken: () => string | null;
  readonly setToken: (token: string | null) => void;
  /** The session is gone (refresh refused with 401/403): clear the stores and go to the sign-in page. */
  readonly onAuthFailure: (error: ApiError) => void;
}

export interface ApiRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Resource path below `/api/v1`, e.g. `cases/123`. */
  readonly path: string;
  readonly body?: unknown;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ApiClient {
  /** Sends the request and returns `data` from the envelope, checked against the contract's response schema. */
  request<S extends z.ZodType>(request: ApiRequest, schema: S): Promise<z.output<S>>;
  /** For endpoints without a body to read (204, or an acknowledgement). */
  request(request: ApiRequest): Promise<void>;
  /** Rotates the refresh cookie and stores the new access token; concurrent callers share one refresh. Resolves to `data`. */
  refresh(): Promise<unknown>;
  /** The `setToken` of the config, for resource calls that start or end a session (login, logout). */
  readonly setToken: ApiClientConfig['setToken'];
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

/**
 * Refreshes are serialised across the tabs of this browser (Web Locks): two tabs rotating the same refresh cookie at once
 * would look like token reuse and end the whole session (D-082). Without the API (tests, old browsers) only this tab's
 * single flight applies.
 */
function withRefreshLock<T>(realm: Realm, run: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  return locks ? locks.request(`nlq-refresh-${realm}`, run) : run();
}

function requestIdOf(response: AxiosResponse): string | undefined {
  const id: unknown = (response.data as { meta?: { requestId?: unknown } } | null)?.meta?.requestId ?? response.headers[REQUEST_ID_HEADER];
  return typeof id === 'string' ? id : undefined;
}

function unwrap(response: AxiosResponse): unknown {
  const body: unknown = response.data;
  if (response.status === 204 || body === '' || body === undefined) {
    return undefined;
  }
  if ((body as { success?: unknown } | null)?.success !== true) {
    throw new ApiError('SYS-001', 'Response is not an API envelope', response.status, [], requestIdOf(response));
  }
  return (body as { data: unknown }).data;
}

/** One typed client per SPA: envelope unwrap, `ApiError` normalisation and single-flight token refresh. */
export function createApiClient(config: ApiClientConfig): ApiClient {
  const http = axios.create({
    baseURL: buildApiUrl(config.baseURL, ''),
    timeout: REQUEST_TIMEOUT_MS,
    // The refresh cookie is set by login/register and read by refresh/logout, on the API's own origin (D-050).
    withCredentials: true,
    // Required by the cookie endpoints (CSRF, D-055); harmless elsewhere.
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });

  let refreshing: Promise<unknown> | null = null;

  function refresh(): Promise<unknown> {
    refreshing ??= withRefreshLock(config.realm, () => http.post(REFRESH_PATH[config.realm]))
      .then((response) => {
        const data = unwrap(response);
        const token = (data as { accessToken?: unknown } | undefined)?.accessToken;
        if (typeof token !== 'string') {
          throw new ApiError('SYS-001', 'Refresh response has no access token', response.status, [], requestIdOf(response));
        }
        config.setToken(token);
        return data;
      })
      .catch((error: unknown) => {
        const apiError = toApiError(error);
        // Only a refusal ends the session; offline or a 5xx keeps it so the user can retry.
        if (apiError instanceof ApiError && (apiError.status === 401 || apiError.status === 403)) {
          config.setToken(null);
          config.onAuthFailure(apiError);
        }
        throw apiError;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  async function send(request: ApiRequest, retried = false): Promise<AxiosResponse> {
    const token = config.getToken();
    try {
      return await http.request({
        method: request.method,
        url: request.path.replace(/^\/+/, ''),
        data: request.body,
        params: request.query,
        signal: request.signal,
        headers: { ...request.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
    } catch (error) {
      const apiError = toApiError(error);
      // Expired access token: refresh once (joining a refresh already running) and retry once. A request that was sent
      // with a token another refresh has since replaced just retries with the new one.
      if (!retried && apiError instanceof ApiError && apiError.code === 'AUTH-002') {
        if (config.getToken() === token) {
          await refresh();
        }
        return send(request, true);
      }
      throw apiError;
    }
  }

  async function request(apiRequest: ApiRequest, schema?: z.ZodType): Promise<unknown> {
    const response = await send(apiRequest);
    const data = unwrap(response);
    if (!schema) {
      return undefined;
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      // The server and this build disagree on the contract (a deploy in progress, a bug): never hand the UI bad data.
      throw new ApiError('SYS-001', `Response does not match the contract: ${parsed.error.message}`, response.status, [], requestIdOf(response));
    }
    return parsed.data;
  }

  return { request: request as ApiClient['request'], refresh, setToken: config.setToken };
}

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/**
 * `Idempotency-Key` header for create endpoints that honour it (uploads, invoices, sessions — api-conventions.md). Create
 * the key once per user action and reuse it when that action is retried, so a retry never creates a second record.
 */
export function idempotencyHeaders(key: string = crypto.randomUUID()): Record<string, string> {
  return { [IDEMPOTENCY_HEADER]: key };
}
