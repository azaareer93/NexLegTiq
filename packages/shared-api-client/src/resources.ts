import {
  AuthSessionSchema,
  CaseListItemSchema,
  CaseSchema,
  ClientListItemSchema,
  ClientSchema,
  ContactPersonSchema,
  CourtSchema,
  DirectoryUserSchema,
  JudgeSchema,
  OfficeSubscriptionSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  OfficeSubscription,
  AuthSession,
  Case,
  CaseListItem,
  CaseQuerySchema,
  ChangePasswordRequestSchema,
  Client,
  ClientListItem,
  ClientQuerySchema,
  ContactPerson,
  Court,
  CourtQuerySchema,
  CreateCaseSchema,
  CreateClientSchema,
  CreateContactPersonSchema,
  UpdateClientRequest,
  UpdateContactPersonRequest,
  DirectoryUser,
  ForgotPasswordRequestSchema,
  Judge,
  LoginRequestSchema,
  RegisterRequestSchema,
  ResendVerificationRequestSchema,
  ResetPasswordRequestSchema,
  UpdateCaseRequest,
  VerifyEmailRequestSchema,
} from '@nexlegtiq/shared-contracts';
import type { z } from 'zod';

import type { ApiClient, Page } from './api-client.js';
import { ApiError } from './api-error.js';

// Request bodies are typed as the schemas' *input* (defaults may be omitted); forms validate with the same schemas.
type Input<S extends z.ZodType> = z.input<S>;

/** A session as the app keeps it: the access token stays inside the client (`setToken`), never in app state or caches (D-050). */
export type ClientSession = Omit<AuthSession, 'accessToken'>;

function withoutToken({ accessToken: _token, ...session }: AuthSession): ClientSession {
  return session;
}

/**
 * Office auth endpoints (api-conventions.md#endpoint-map). Calls that start a session store its access token through
 * `client.setToken` and return the session without it; the refresh cookie is handled by the browser.
 */
export function authApi(client: ApiClient) {
  const startSession = async (path: string, body: unknown): Promise<ClientSession> => {
    const session = await client.sessionRequest({ method: 'POST', path, body }, AuthSessionSchema);
    client.setToken(session.accessToken);
    return withoutToken(session);
  };

  return {
    register: (body: Input<typeof RegisterRequestSchema>) => startSession('auth/register', body),
    login: (body: Input<typeof LoginRequestSchema>) => startSession('auth/login', body),
    /**
     * Restores the session from the refresh cookie (app start, reload); shares the client's single flight. Rejects with
     * the server's code when there is no session (no `onAuthFailure`: the current page decides where to go).
     */
    refresh: async (): Promise<ClientSession> => {
      const parsed = AuthSessionSchema.safeParse(await client.refresh());
      if (!parsed.success) {
        client.setToken(null);
        throw new ApiError('SYS-001', 'Refresh response does not match the session contract', 200);
      }
      return withoutToken(parsed.data);
    },
    logout: async (): Promise<void> => {
      try {
        await client.sessionRequest({ method: 'POST', path: 'auth/logout' });
      } finally {
        // Signed out locally even when the server could not be reached; the cookie then expires on its own.
        client.setToken(null);
      }
    },
    verifyEmail: (body: Input<typeof VerifyEmailRequestSchema>) =>
      client.request({ method: 'POST', path: 'auth/verify-email', body }),
    resendVerification: (body: Input<typeof ResendVerificationRequestSchema>) =>
      client.request({ method: 'POST', path: 'auth/resend-verification', body }),
    forgotPassword: (body: Input<typeof ForgotPasswordRequestSchema>) =>
      client.request({ method: 'POST', path: 'auth/forgot-password', body }),
    resetPassword: (body: Input<typeof ResetPasswordRequestSchema>) =>
      client.request({ method: 'POST', path: 'auth/reset-password', body }),
  };
}

/** The signed-in user's own account. `GET/PATCH users/me` and the team endpoints join when the backend has them. */
export function usersApi(client: ApiClient) {
  return {
    changePassword: (body: Input<typeof ChangePasswordRequestSchema>) =>
      client.request({ method: 'POST', path: 'users/me/password', body }),
    /** Active colleagues (name and role) for pickers (D-123). */
    directory: (signal?: AbortSignal): Promise<DirectoryUser[]> =>
      client.request(
        { method: 'GET', path: 'users/directory', signal },
        DirectoryUserSchema.array(),
      ),
  };
}

/**
 * `GET /cases` parameters as they travel in the query string (`CaseQuerySchema` input): `fileType` may list several types
 * (`LITIGATION,CRIMINAL`), `sort` is `field:dir,…`.
 */
export type CaseListParams = Partial<Record<keyof z.input<typeof CaseQuerySchema>, string>>;

/** Legal files (W6, D-096). Create joins with the quick-create form. */
export function casesApi(client: ApiClient) {
  const path = (id: string) => `cases/${encodeURIComponent(id)}`;
  return {
    list: (query: CaseListParams, signal?: AbortSignal): Promise<Page<CaseListItem>> =>
      client.requestPage({ method: 'GET', path: 'cases', query, signal }, CaseListItemSchema),
    get: (id: string, signal?: AbortSignal): Promise<Case> =>
      client.request({ method: 'GET', path: path(id), signal }, CaseSchema),
    create: (body: Input<typeof CreateCaseSchema>): Promise<Case> =>
      client.request({ method: 'POST', path: 'cases', body }, CaseSchema),
    update: (id: string, body: UpdateCaseRequest): Promise<Case> =>
      client.request({ method: 'PATCH', path: path(id), body }, CaseSchema),
    remove: (id: string): Promise<void> => client.request({ method: 'DELETE', path: path(id) }),
  };
}

/** `GET /clients` parameters as they travel in the query string (`ClientQuerySchema` input). */
export type ClientListParams = Partial<Record<keyof z.input<typeof ClientQuerySchema>, string>>;

/** Clients and their contact persons (D-108). */
export function clientsApi(client: ApiClient) {
  const path = (id: string) => `clients/${encodeURIComponent(id)}`;
  const contact = (id: string, contactId: string) =>
    `${path(id)}/contacts/${encodeURIComponent(contactId)}`;
  return {
    list: (query: ClientListParams, signal?: AbortSignal): Promise<Page<ClientListItem>> =>
      client.requestPage({ method: 'GET', path: 'clients', query, signal }, ClientListItemSchema),
    get: (id: string, signal?: AbortSignal): Promise<Client> =>
      client.request({ method: 'GET', path: path(id), signal }, ClientSchema),
    create: (body: Input<typeof CreateClientSchema>): Promise<Client> =>
      client.request({ method: 'POST', path: 'clients', body }, ClientSchema),
    update: (id: string, body: UpdateClientRequest): Promise<Client> =>
      client.request({ method: 'PATCH', path: path(id), body }, ClientSchema),
    addContact: (
      id: string,
      body: Input<typeof CreateContactPersonSchema>,
    ): Promise<ContactPerson> =>
      client.request({ method: 'POST', path: `${path(id)}/contacts`, body }, ContactPersonSchema),
    updateContact: (
      id: string,
      contactId: string,
      body: UpdateContactPersonRequest,
    ): Promise<ContactPerson> =>
      client.request({ method: 'PATCH', path: contact(id, contactId), body }, ContactPersonSchema),
    removeContact: (id: string, contactId: string): Promise<void> =>
      client.request({ method: 'DELETE', path: contact(id, contactId) }),
  };
}

/** `GET /courts` parameters as they travel in the query string (`CourtQuerySchema` input). */
export type CourtListParams = Partial<Record<keyof z.input<typeof CourtQuerySchema>, string>>;

/** Courts and their judges (D-115): platform rows and the office's own. */
export function courtsApi(client: ApiClient) {
  return {
    list: (query: CourtListParams, signal?: AbortSignal): Promise<Page<Court>> =>
      client.requestPage({ method: 'GET', path: 'courts', query, signal }, CourtSchema),
    judges: (courtId: string, signal?: AbortSignal): Promise<Judge[]> =>
      client.request(
        { method: 'GET', path: `courts/${encodeURIComponent(courtId)}/judges`, signal },
        JudgeSchema.array(),
      ),
  };
}

/** `offices/me…` (api-conventions.md#offices): the office's subscription and usage (D-122). */
export function officesApi(client: ApiClient) {
  return {
    subscription: (signal?: AbortSignal): Promise<OfficeSubscription> =>
      client.request(
        { method: 'GET', path: 'offices/me/subscription', signal },
        OfficeSubscriptionSchema,
      ),
  };
}
