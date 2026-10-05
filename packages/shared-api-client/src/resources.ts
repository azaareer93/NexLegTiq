import { AuthSessionSchema } from '@nexlegtiq/shared-contracts';
import type {
  AuthSession,
  ChangePasswordRequestSchema,
  ForgotPasswordRequestSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  ResendVerificationRequestSchema,
  ResetPasswordRequestSchema,
  VerifyEmailRequestSchema,
} from '@nexlegtiq/shared-contracts';
import type { z } from 'zod';

import type { ApiClient } from './api-client.js';
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
    verifyEmail: (body: Input<typeof VerifyEmailRequestSchema>) => client.request({ method: 'POST', path: 'auth/verify-email', body }),
    resendVerification: (body: Input<typeof ResendVerificationRequestSchema>) =>
      client.request({ method: 'POST', path: 'auth/resend-verification', body }),
    forgotPassword: (body: Input<typeof ForgotPasswordRequestSchema>) =>
      client.request({ method: 'POST', path: 'auth/forgot-password', body }),
    resetPassword: (body: Input<typeof ResetPasswordRequestSchema>) => client.request({ method: 'POST', path: 'auth/reset-password', body }),
  };
}

/** The signed-in user's own account. `GET/PATCH users/me` and the team endpoints join when the backend has them. */
export function usersApi(client: ApiClient) {
  return {
    changePassword: (body: Input<typeof ChangePasswordRequestSchema>) => client.request({ method: 'POST', path: 'users/me/password', body }),
  };
}
