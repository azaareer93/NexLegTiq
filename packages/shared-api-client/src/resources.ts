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

// Request bodies are typed as the schemas' *input* (defaults may be omitted); forms validate with the same schemas.
type Input<S extends z.ZodType> = z.input<S>;

/**
 * Office auth endpoints (api-conventions.md#endpoint-map). Calls that start a session store its access token through
 * `client.setToken`; the refresh cookie is handled by the browser.
 */
export function authApi(client: ApiClient) {
  const startSession = async (path: string, body: unknown): Promise<AuthSession> => {
    const session = await client.request({ method: 'POST', path, body }, AuthSessionSchema);
    client.setToken(session.accessToken);
    return session;
  };

  return {
    register: (body: Input<typeof RegisterRequestSchema>) => startSession('auth/register', body),
    login: (body: Input<typeof LoginRequestSchema>) => startSession('auth/login', body),
    /** Restores the session from the refresh cookie (app start, reload); shares the client's single flight. */
    refresh: async (): Promise<AuthSession> => AuthSessionSchema.parse(await client.refresh()),
    logout: async (): Promise<void> => {
      try {
        await client.request({ method: 'POST', path: 'auth/logout' });
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
