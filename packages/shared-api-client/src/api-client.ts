import type { PaginationMeta } from '@nexlegtiq/shared-types';
import axios from 'axios';
import type { AxiosResponse } from 'axios';
import { z } from 'zod';

import { ApiError, REQUEST_ID_HEADER, toApiError } from './api-error.js';
import { buildApiUrl } from './api-url.js';

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
  /** A paginated list (api-conventions.md): every item checked against `itemSchema`, plus `meta.pagination`. */
  requestPage<S extends z.ZodType>(request: ApiRequest, itemSchema: S): Promise<Page<z.output<S>>>;
  /**
   * For the public endpoints that start or end a session (login, register, logout): sent after any refresh in flight and
   * under the cross-tab refresh lock, never refreshed or retried.
   */
  sessionRequest<S extends z.ZodType>(request: ApiRequest, schema: S): Promise<z.output<S>>;
  sessionRequest(request: ApiRequest): Promise<void>;
  /**
   * Rotates the refresh cookie and stores the new access token; concurrent callers share one refresh. Resolves to `data`
   * (checked for `accessToken` only). A refusal clears the token but does not call `onAuthFailure`.
   */
  refresh(): Promise<unknown>;
  /** The `setToken` of the config, for resource calls that start or end a session (login, logout). */
  readonly setToken: ApiClientConfig['setToken'];
}

/** One page of a list endpoint. */
export interface Page<T> {
  readonly items: T[];
  readonly pagination: PaginationMeta;
}

const PaginationSchema = z.object({
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
  hasMore: z.boolean(),
});

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
  const id: unknown =
    (response.data as { meta?: { requestId?: unknown } } | null)?.meta?.requestId ??
    response.headers[REQUEST_ID_HEADER];
  return typeof id === 'string' ? id : undefined;
}

function unwrap(response: AxiosResponse): unknown {
  const body: unknown = response.data;
  if (response.status === 204 || body === '' || body === undefined) {
    return undefined;
  }
  if ((body as { success?: unknown } | null)?.success !== true) {
    throw new ApiError(
      'SYS-001',
      'Response is not an API envelope',
      response.status,
      [],
      requestIdOf(response),
    );
  }
  return (body as { data: unknown }).data;
}

/** The server refused the session (not a network or server failure): the user must sign in again. */
function isRefusal(error: ApiError): boolean {
  // A 403 AUTH-100 (CSRF/Origin misconfiguration) keeps the cookie on the server, so it does not end the session here either.
  return error.status === 401 || error.code === 'AUTH-006' || error.code === 'AUTH-010';
}

/** One typed client per SPA: envelope unwrap, `ApiError` normalisation and single-flight token refresh. */
export function createApiClient(config: ApiClientConfig): ApiClient {
  const http = axios.create({
    baseURL: buildApiUrl(config.baseURL, ''),
    // A `path` is always below the API: an absolute URL can never carry the bearer token to another host.
    allowAbsoluteUrls: false,
    timeout: REQUEST_TIMEOUT_MS,
    // The refresh cookie is set by login/register and read by refresh/logout, on the API's own origin (D-050).
    withCredentials: true,
    // Required by the cookie endpoints (CSRF, D-055); harmless elsewhere.
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });

  /** The refresh in flight in this tab; `notify` turns on as soon as a request that got AUTH-002 waits for it. */
  let refreshing: { promise: Promise<unknown>; notify: boolean } | null = null;

  function refresh(notify = false): Promise<unknown> {
    if (refreshing) {
      refreshing.notify ||= notify;
      return refreshing.promise;
    }
    const state = { notify, promise: Promise.resolve<unknown>(undefined) };
    state.promise = withRefreshLock(config.realm, () => http.post(REFRESH_PATH[config.realm]))
      .then((response) => {
        const data = unwrap(response);
        const token = (data as { accessToken?: unknown } | undefined)?.accessToken;
        if (typeof token !== 'string') {
          throw new ApiError(
            'SYS-001',
            'Refresh response has no access token',
            response.status,
            [],
            requestIdOf(response),
          );
        }
        config.setToken(token);
        return data;
      })
      .catch((error: unknown) => {
        const apiError = toApiError(error);
        // Only a refusal ends the session; offline or a 5xx keeps it so the user can retry. `onAuthFailure` is for
        // sessions lost mid-use: restoring the session at app start (`authApi.refresh`) just rejects, so public pages
        // (reset-password, verify-email links) are not sent to the sign-in page.
        if (apiError instanceof ApiError && isRefusal(apiError)) {
          config.setToken(null);
          if (state.notify) {
            config.onAuthFailure(apiError);
          }
        }
        throw apiError;
      })
      .finally(() => {
        refreshing = null;
      });
    refreshing = state;
    return state.promise;
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
      // with a token another refresh has since replaced just retries with the new one; once the session has ended
      // (token cleared by a refused refresh) it fails as it is.
      if (!retried && apiError instanceof ApiError && apiError.code === 'AUTH-002') {
        const current = config.getToken();
        if (current === null) {
          throw apiError;
        }
        if (current === token) {
          await refresh(true);
        }
        return send(request, true);
      }
      throw apiError;
    }
  }

  function parse(response: AxiosResponse, schema?: z.ZodType): unknown {
    const data = unwrap(response);
    return schema ? checked(response, schema, data) : undefined;
  }

  function checked(response: AxiosResponse, schema: z.ZodType, data: unknown): unknown {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      // The server and this build disagree on the contract (a deploy in progress, a bug): never hand the UI bad data.
      // Only paths and issue codes go into the message, never values (it may reach logs).
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
        .join(', ');
      throw new ApiError(
        'SYS-001',
        `Response does not match the contract (${issues})`,
        response.status,
        [],
        requestIdOf(response),
      );
    }
    return parsed.data;
  }

  async function request(apiRequest: ApiRequest, schema?: z.ZodType): Promise<unknown> {
    return parse(await send(apiRequest), schema);
  }

  async function requestPage(
    apiRequest: ApiRequest,
    itemSchema: z.ZodType,
  ): Promise<Page<unknown>> {
    const response = await send(apiRequest);
    const items = checked(response, z.array(itemSchema), unwrap(response)) as unknown[];
    const meta = (response.data as { meta?: { pagination?: unknown } }).meta;
    const pagination = checked(response, PaginationSchema, meta?.pagination) as PaginationMeta;
    return { items, pagination };
  }

  async function sessionRequest(apiRequest: ApiRequest, schema?: z.ZodType): Promise<unknown> {
    // Wait for this tab's refresh, then hold the cross-tab refresh lock: a rotation finishing during a logout would
    // otherwise leave a live refresh cookie behind (the old cookie logs nothing out), or overwrite a new login's cookie.
    await refreshing?.promise.catch(() => undefined);
    // Session endpoints are public: never refresh from inside the lock (it would wait for itself).
    return withRefreshLock(config.realm, async () => parse(await send(apiRequest, true), schema));
  }

  return {
    request: request as ApiClient['request'],
    requestPage: requestPage as ApiClient['requestPage'],
    sessionRequest: sessionRequest as ApiClient['sessionRequest'],
    refresh: () => refresh(),
    setToken: config.setToken,
  };
}

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/**
 * `Idempotency-Key` header for create endpoints that honour it (uploads, invoices, sessions — api-conventions.md). Create
 * the key once when the user starts the action (`crypto.randomUUID()`) and pass the same key on every retry of that
 * action, so a retry never creates a second record.
 */
export function idempotencyHeaders(key: string): Record<string, string> {
  return { [IDEMPOTENCY_HEADER]: key };
}
