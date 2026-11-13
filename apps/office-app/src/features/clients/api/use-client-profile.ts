import { clientProfileApi } from '@nexlegtiq/shared-api-client';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { clientKeys } from './use-clients';
import { apiClient } from '../../auth';

const profile = clientProfileApi(apiClient);

/** Keys under the client's detail: a client write refreshes its profile tabs too. */
const keys = {
  documents: (id: string, page: number) => [...clientKeys.detail(id), 'documents', page] as const,
  invoices: (id: string, page: number) => [...clientKeys.detail(id), 'invoices', page] as const,
  summary: (id: string) => [...clientKeys.detail(id), 'invoice-summary'] as const,
};

/** `GET /clients/:id/documents`: one page of the documents on the client's files the user may see. */
export const useClientDocuments = (id: string, page: number) =>
  useQuery({
    queryKey: keys.documents(id, page),
    queryFn: ({ signal }) => profile.documents(id, { page: String(page) }, signal),
    placeholderData: keepPreviousData,
  });

/** `GET /invoices?clientId=`: one page of the client's invoices the user may see (D-162). */
export const useClientInvoices = (id: string, page: number) =>
  useQuery({
    queryKey: keys.invoices(id, page),
    queryFn: ({ signal }) => profile.invoices({ clientId: id, page: String(page) }, signal),
    placeholderData: keepPreviousData,
  });

/** Billed and outstanding per currency; only asked for by invoice viewers. */
export const useClientInvoiceSummary = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: keys.summary(id),
    queryFn: ({ signal }) => profile.invoiceSummary(id, signal),
    enabled,
  });
