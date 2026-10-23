import {
  AuthSessionSchema,
  InvitationSchema,
  InvitePreviewSchema,
  CaseListItemSchema,
  CaseSchema,
  ClientListItemSchema,
  ClientSchema,
  ContactPersonSchema,
  CourtSchema,
  DirectoryUserSchema,
  JudgeSchema,
  OfficeProfileSchema,
  SessionListItemSchema,
  SessionSchema,
  OfficeSettingsSchema,
  TeamMemberSchema,
  UserOpenFileSchema,
  OfficeSubscriptionSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AcceptInviteRequestSchema,
  Invitation,
  InvitePreview,
  InviteUserRequest,
  ChangeRoleRequest,
  DeactivateUserRequest,
  OfficeProfile,
  OfficeSettings,
  TeamMember,
  UpdateOfficeProfileRequest,
  UpdateOfficeSettingsRequest,
  UserOpenFile,
  OfficeSubscription,
  CancelSessionRequest,
  CreateCourtSchema,
  CreateJudgeSchema,
  CreateSessionSchema,
  Session,
  SessionListItem,
  SessionOutcomeSchema,
  UpdateSessionSchema,
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
    /** Accepts a team invitation (D-134): creates the account and signs it in like login. */
    acceptInvite: (body: Input<typeof AcceptInviteRequestSchema>) =>
      startSession('auth/accept-invite', body),
    /** What the invitation link offers (410 RES-004 when it is no longer valid). */
    invitePreview: (token: string, signal?: AbortSignal): Promise<InvitePreview> =>
      client.request(
        { method: 'POST', path: 'auth/invites/preview', body: { token }, signal },
        InvitePreviewSchema,
      ),
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
    /** Team management (D-124): every user of the office with their open-file counts. */
    team: (signal?: AbortSignal): Promise<TeamMember[]> =>
      client.request({ method: 'GET', path: 'users', signal }, TeamMemberSchema.array()),
    /** Open files a user is responsible for: what deactivating them must reassign. */
    openFiles: (id: string, signal?: AbortSignal): Promise<UserOpenFile[]> =>
      client.request(
        { method: 'GET', path: `users/${encodeURIComponent(id)}/open-files`, signal },
        UserOpenFileSchema.array(),
      ),
    changeRole: (id: string, body: ChangeRoleRequest): Promise<TeamMember> =>
      client.request(
        { method: 'PATCH', path: `users/${encodeURIComponent(id)}/role`, body },
        TeamMemberSchema,
      ),
    deactivate: (id: string, body: DeactivateUserRequest): Promise<TeamMember> =>
      client.request(
        { method: 'POST', path: `users/${encodeURIComponent(id)}/deactivate`, body },
        TeamMemberSchema,
      ),
    reactivate: (id: string): Promise<TeamMember> =>
      client.request(
        { method: 'POST', path: `users/${encodeURIComponent(id)}/reactivate` },
        TeamMemberSchema,
      ),
    /** Invitations (D-134): invite one person, list the pending ones, resend or revoke one. */
    invite: (body: InviteUserRequest): Promise<Invitation> =>
      client.request({ method: 'POST', path: 'users/invite', body }, InvitationSchema),
    invitations: (signal?: AbortSignal): Promise<Invitation[]> =>
      client.request(
        { method: 'GET', path: 'users/invitations', signal },
        InvitationSchema.array(),
      ),
    resendInvitation: (id: string): Promise<Invitation> =>
      client.request(
        { method: 'POST', path: `users/invitations/${encodeURIComponent(id)}/resend` },
        InvitationSchema,
      ),
    revokeInvitation: (id: string): Promise<void> =>
      client.request({ method: 'DELETE', path: `users/invitations/${encodeURIComponent(id)}` }),
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
    /** An office court (D-115); the jurisdiction defaults to the office's. */
    create: (body: Input<typeof CreateCourtSchema>): Promise<Court> =>
      client.request({ method: 'POST', path: 'courts', body }, CourtSchema),
    /** An office judge at a court (also at a platform court). */
    createJudge: (courtId: string, body: Input<typeof CreateJudgeSchema>): Promise<Judge> =>
      client.request(
        { method: 'POST', path: `courts/${encodeURIComponent(courtId)}/judges`, body },
        JudgeSchema,
      ),
  };
}

/** `offices/me…` (api-conventions.md#offices): the office's subscription and usage (D-122). */
export function officesApi(client: ApiClient) {
  return {
    profile: (signal?: AbortSignal): Promise<OfficeProfile> =>
      client.request({ method: 'GET', path: 'offices/me', signal }, OfficeProfileSchema),
    updateProfile: (body: UpdateOfficeProfileRequest): Promise<OfficeProfile> =>
      client.request({ method: 'PATCH', path: 'offices/me', body }, OfficeProfileSchema),
    settings: (signal?: AbortSignal): Promise<OfficeSettings> =>
      client.request({ method: 'GET', path: 'offices/me/settings', signal }, OfficeSettingsSchema),
    updateSettings: (body: UpdateOfficeSettingsRequest): Promise<OfficeSettings> =>
      client.request({ method: 'PATCH', path: 'offices/me/settings', body }, OfficeSettingsSchema),
    subscription: (signal?: AbortSignal): Promise<OfficeSubscription> =>
      client.request(
        { method: 'GET', path: 'offices/me/subscription', signal },
        OfficeSubscriptionSchema,
      ),
  };
}

/** `GET /cases/:id/sessions` (D-116): upcoming soonest first, past latest first. */
export type FileSessionsParams = {
  readonly when: 'upcoming' | 'past';
  readonly page?: number;
  readonly limit?: number;
};

/** Hearings (D-116, D-117). Instants are sent with an offset and come back in UTC. */
export function sessionsApi(client: ApiClient) {
  const path = (id: string) => `sessions/${encodeURIComponent(id)}`;
  return {
    forFile: (
      fileId: string,
      query: FileSessionsParams,
      signal?: AbortSignal,
    ): Promise<Page<SessionListItem>> =>
      client.requestPage(
        { method: 'GET', path: `cases/${encodeURIComponent(fileId)}/sessions`, query, signal },
        SessionListItemSchema,
      ),
    get: (id: string, signal?: AbortSignal): Promise<Session> =>
      client.request({ method: 'GET', path: path(id), signal }, SessionSchema),
    /** 409 BIZ-004 when the attending lawyer is busy, unless `acknowledgeConflict`. */
    create: (body: Input<typeof CreateSessionSchema>): Promise<Session> =>
      client.request({ method: 'POST', path: 'sessions', body }, SessionSchema),
    update: (id: string, body: Input<typeof UpdateSessionSchema>): Promise<Session> =>
      client.request({ method: 'PATCH', path: path(id), body }, SessionSchema),
    cancel: (id: string, body: CancelSessionRequest): Promise<Session> =>
      client.request({ method: 'POST', path: `${path(id)}/cancel`, body }, SessionSchema),
    outcome: (id: string, body: Input<typeof SessionOutcomeSchema>): Promise<Session> =>
      client.request({ method: 'POST', path: `${path(id)}/outcome`, body }, SessionSchema),
  };
}
