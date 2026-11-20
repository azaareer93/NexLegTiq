import { useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import { useTranslation } from 'react-i18next';

import { portal, usePortalSession } from '../auth';

export const portalKeys = {
  all: ['portal'] as const,
  files: () => [...portalKeys.all, 'files'] as const,
  file: (id: string) => [...portalKeys.all, 'file', id] as const,
  documents: (id: string) => [...portalKeys.all, 'file', id, 'documents'] as const,
  uploads: (id: string) => [...portalKeys.all, 'file', id, 'uploads'] as const,
  invoices: () => [...portalKeys.all, 'invoices'] as const,
};

export const useFiles = () =>
  useQuery({ queryKey: portalKeys.files(), queryFn: ({ signal }) => portal.files(signal) });

export const useFile = (id: string) =>
  useQuery({ queryKey: portalKeys.file(id), queryFn: ({ signal }) => portal.file(id, signal) });

export const useDocuments = (id: string) =>
  useQuery({
    queryKey: portalKeys.documents(id),
    queryFn: ({ signal }) => portal.documents(id, signal),
  });

export const useUploads = (id: string) =>
  useQuery({
    queryKey: portalKeys.uploads(id),
    queryFn: ({ signal }) => portal.uploads(id, signal),
  });

/** Sends one picked file; a new idempotency key per pick, so only a retry of the same pick can be deduplicated. */
export function useUpload(fileId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ file, key }: { file: File; key: string }) =>
      portal.upload(fileId, file, file.name, { idempotencyKey: key }),
    onSettled: () => qc.invalidateQueries({ queryKey: portalKeys.uploads(fileId) }),
  });
}

/** Follows a download link: storage serves an attachment (D-085), so the page stays. */
export function openDownload(url: string): void {
  const link = window.document.createElement('a');
  link.href = url;
  link.rel = 'noopener noreferrer';
  link.click();
}

/** A shared document's 5-minute link, followed at once; a failure is shown as a notification. */
export function useDownload() {
  const { notify } = useApiErrorHandler();
  return useMutation({
    gcTime: 0,
    mutationFn: async (documentId: string) => (await portal.downloadLink(documentId)).downloadUrl,
    onSuccess: openDownload,
    onError: notify,
  });
}

/** The office of a file or invoice, from the session: its name and public contact details. */
export function useOffice(officeId: string | undefined) {
  return usePortalSession((state) => state.user?.offices.find((o) => o.officeId === officeId));
}

/** Invoice PDF: READY is downloaded, RENDERING tells the client to ask again in a moment. */
export function useInvoicePdf() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  return useMutation({
    gcTime: 0,
    mutationFn: (id: string) => portal.invoicePdf(id),
    onSuccess: (answer) => {
      // shortcut: no automatic polling while the office's worker renders; add it if clients report retrying by hand.
      if (answer.status === 'READY') openDownload(answer.downloadUrl);
      else void message.info(t('portal.invoices.preparing'));
    },
    onError: notify,
  });
}

export const useInvoices = () =>
  useQuery({ queryKey: portalKeys.invoices(), queryFn: ({ signal }) => portal.invoices(signal) });
