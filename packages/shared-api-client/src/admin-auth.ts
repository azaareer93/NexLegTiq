import {
  AdminEnrollmentSchema,
  AdminProfileSchema,
  AdminSessionSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AdminConfirmEnrollmentRequest,
  AdminEnrollRequest,
  AdminEnrollment,
  AdminLoginRequest,
  AdminProfile,
  AdminSession,
} from '@nexlegtiq/shared-contracts';

import type { ApiClient } from './api-client.js';
import { ApiError } from './api-error.js';

/** An admin session as the app keeps it: the access token stays inside the client (D-050). */
export type AdminClientSession = Omit<AdminSession, 'accessToken'>;

function withoutToken({ accessToken: _token, ...session }: AdminSession): AdminClientSession {
  return session;
}

/** Platform admin realm (D-145): `admin/auth/*`, refresh cookie `nlq_admin_rt`, refreshes serialised across tabs (D-089). */
export function adminAuthApi(client: ApiClient) {
  const startSession = async (path: string, body: unknown): Promise<AdminClientSession> => {
    const session = await client.sessionRequest({ method: 'POST', path, body }, AdminSessionSchema);
    client.setToken(session.accessToken);
    return withoutToken(session);
  };

  return {
    login: (body: AdminLoginRequest) => startSession('admin/auth/login', body),
    /** First sign-in: the authenticator secret to scan. */
    enroll: (body: AdminEnrollRequest): Promise<AdminEnrollment> =>
      client.sessionRequest(
        { method: 'POST', path: 'admin/auth/enroll', body },
        AdminEnrollmentSchema,
      ),
    /** Confirms the authenticator; the session carries the recovery codes, shown once. */
    confirmEnrollment: (body: AdminConfirmEnrollmentRequest) =>
      startSession('admin/auth/enroll/confirm', body),
    /** Restores the session from the refresh cookie (app start); rejects with the server's code without one. */
    refresh: async (): Promise<AdminClientSession> => {
      const parsed = AdminSessionSchema.safeParse(await client.refresh());
      if (!parsed.success) {
        client.setToken(null);
        throw new ApiError('SYS-001', 'Refresh response does not match the session contract', 200);
      }
      return withoutToken(parsed.data);
    },
    logout: async (): Promise<void> => {
      try {
        await client.sessionRequest({ method: 'POST', path: 'admin/auth/logout' });
      } finally {
        client.setToken(null);
      }
    },
    me: (signal?: AbortSignal): Promise<AdminProfile> =>
      client.request({ method: 'GET', path: 'admin/auth/me', signal }, AdminProfileSchema),
  };
}
