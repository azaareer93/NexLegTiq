import {
  DownloadLinkSchema,
  PortalDocumentSchema,
  PortalFileDetailSchema,
  PortalFileSchema,
  PortalInvitePreviewSchema,
  PortalInvoicePdfSchema,
  PortalInvoiceSchema,
  PortalSessionSchema,
  PortalUploadSchema,
  PortalUserSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  DownloadLink,
  ForgotPasswordRequest,
  PortalAcceptInviteRequest,
  PortalDocument,
  PortalFile,
  PortalFileDetail,
  PortalInvitePreview,
  PortalInvoice,
  PortalInvoicePdf,
  PortalLoginRequest,
  PortalSession,
  PortalUpload,
  PortalUser,
  ResetPasswordRequest,
} from '@nexlegtiq/shared-contracts';

import { idempotencyHeaders } from './api-client.js';
import type { ApiClient } from './api-client.js';
import { ApiError } from './api-error.js';

/** A portal session as the app keeps it: the access token stays inside the client (D-050). */
export type PortalClientSession = Omit<PortalSession, 'accessToken'>;

function withoutToken({ accessToken: _token, ...session }: PortalSession): PortalClientSession {
  return session;
}

/** Client-portal realm (D-158): `portal/auth/*`, refresh cookie `nlq_prt`. */
export function portalAuthApi(client: ApiClient) {
  const startSession = async (path: string, body: unknown): Promise<PortalClientSession> => {
    const session = await client.sessionRequest(
      { method: 'POST', path, body },
      PortalSessionSchema,
    );
    client.setToken(session.accessToken);
    return withoutToken(session);
  };

  return {
    login: (body: PortalLoginRequest) => startSession('portal/auth/login', body),
    /** Accepts the emailed invitation (new account, or the existing account's password) and signs in. */
    acceptInvite: (body: PortalAcceptInviteRequest) =>
      startSession('portal/auth/accept-invite', body),
    /** What the invitation link offers (410 RES-004 when it is no longer valid). */
    invitePreview: (token: string, signal?: AbortSignal): Promise<PortalInvitePreview> =>
      client.request(
        { method: 'POST', path: 'portal/auth/invites/preview', body: { token }, signal },
        PortalInvitePreviewSchema,
      ),
    /** Restores the session from the refresh cookie (app start); rejects with the server's code without one. */
    refresh: async (): Promise<PortalClientSession> => {
      const parsed = PortalSessionSchema.safeParse(await client.refresh());
      if (!parsed.success) {
        client.setToken(null);
        throw new ApiError('SYS-001', 'Refresh response does not match the session contract', 200);
      }
      return withoutToken(parsed.data);
    },
    logout: async (): Promise<void> => {
      try {
        await client.sessionRequest({ method: 'POST', path: 'portal/auth/logout' });
      } finally {
        client.setToken(null);
      }
    },
    me: (signal?: AbortSignal): Promise<PortalUser> =>
      client.request({ method: 'GET', path: 'portal/auth/me', signal }, PortalUserSchema),
    forgotPassword: (body: ForgotPasswordRequest) =>
      client.request({ method: 'POST', path: 'portal/auth/forgot-password', body }),
    resetPassword: (body: ResetPasswordRequest) =>
      client.request({ method: 'POST', path: 'portal/auth/reset-password', body }),
  };
}

/** The client's own data on the portal (D-186, D-187, D-188). */
export function portalApi(client: ApiClient) {
  const file = (id: string) => `portal/files/${encodeURIComponent(id)}`;
  return {
    files: (signal?: AbortSignal): Promise<PortalFile[]> =>
      client.request({ method: 'GET', path: 'portal/files', signal }, PortalFileSchema.array()),
    file: (id: string, signal?: AbortSignal): Promise<PortalFileDetail> =>
      client.request({ method: 'GET', path: file(id), signal }, PortalFileDetailSchema),
    documents: (id: string, signal?: AbortSignal): Promise<PortalDocument[]> =>
      client.request(
        { method: 'GET', path: `${file(id)}/documents`, signal },
        PortalDocumentSchema.array(),
      ),
    uploads: (id: string, signal?: AbortSignal): Promise<PortalUpload[]> =>
      client.request(
        { method: 'GET', path: `${file(id)}/uploads`, signal },
        PortalUploadSchema.array(),
      ),
    /** Multipart `file` (202 SCANNING); one `idempotencyKey` per file the client picked makes a retry safe. */
    upload: (
      id: string,
      upload: Blob,
      filename: string,
      {
        onProgress,
        idempotencyKey,
      }: { onProgress?: (fraction: number) => void; idempotencyKey?: string } = {},
    ): Promise<PortalUpload> => {
      const form = new FormData();
      form.append('file', upload, filename);
      return client.request(
        {
          method: 'POST',
          path: `${file(id)}/uploads`,
          body: form,
          ...(onProgress && { onUploadProgress: onProgress }),
          ...(idempotencyKey && { headers: idempotencyHeaders(idempotencyKey) }),
        },
        PortalUploadSchema,
      );
    },
    /** A 5-minute link to a shared document (audited). */
    downloadLink: (documentId: string): Promise<DownloadLink> =>
      client.request(
        { method: 'GET', path: `portal/documents/${encodeURIComponent(documentId)}/download` },
        DownloadLinkSchema,
      ),
    invoices: (signal?: AbortSignal): Promise<PortalInvoice[]> =>
      client.request(
        { method: 'GET', path: 'portal/invoices', signal },
        PortalInvoiceSchema.array(),
      ),
    /** READY with a link, or RENDERING while the office's worker prints it (ask again). */
    invoicePdf: (id: string): Promise<PortalInvoicePdf> =>
      client.request(
        { method: 'GET', path: `portal/invoices/${encodeURIComponent(id)}/pdf` },
        PortalInvoicePdfSchema,
      ),
  };
}
