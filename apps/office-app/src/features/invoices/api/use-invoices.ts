import { invoicesApi } from '@nexlegtiq/shared-api-client';
import type { InvoiceListParams } from '@nexlegtiq/shared-api-client';
import type {
  CreateInvoiceRequest,
  MarkInvoicePaidRequest,
  RetainerDepositRequest,
  SendInvoiceRequest,
} from '@nexlegtiq/shared-contracts';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../../auth';

const invoices = invoicesApi(apiClient);

/** Every invoice write refreshes invoice lists, retainers and the billing tab's entries (an invoice links entries). */
export const invoiceKeys = {
  all: ['invoices'] as const,
  list: (query: InvoiceListParams) => [...invoiceKeys.all, 'list', query] as const,
  detail: (id: string) => [...invoiceKeys.all, 'detail', id] as const,
  retainer: (fileId: string) => [...invoiceKeys.all, 'retainer', fileId] as const,
};

export const useInvoices = (query: InvoiceListParams) =>
  useQuery({
    queryKey: invoiceKeys.list(query),
    queryFn: ({ signal }) => invoices.list(query, signal),
    placeholderData: keepPreviousData,
  });

export const useRetainer = (fileId: string, enabled: boolean) =>
  useQuery({
    queryKey: invoiceKeys.retainer(fileId),
    queryFn: ({ signal }) => invoices.retainer(fileId, signal),
    enabled,
  });

export function useInvoiceMutations() {
  const queryClient = useQueryClient();
  const onSuccess = async () => {
    await queryClient.invalidateQueries({ queryKey: invoiceKeys.all });
    // Drafting or voiding links or frees time entries; their table shows "invoiced".
    await queryClient.invalidateQueries({ queryKey: ['time-entries'] });
  };
  return {
    create: useMutation({
      mutationFn: (body: CreateInvoiceRequest) => invoices.create(body),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: (id: string) => invoices.remove(id), onSuccess }),
    send: useMutation({
      mutationFn: ({ id, body }: { id: string; body?: SendInvoiceRequest }) =>
        invoices.send(id, body),
      onSuccess,
    }),
    markPaid: useMutation({
      mutationFn: ({ id, body }: { id: string; body: MarkInvoicePaidRequest }) =>
        invoices.markPaid(id, body),
      onSuccess,
    }),
    void: useMutation({ mutationFn: (id: string) => invoices.void(id), onSuccess }),
    deposit: useMutation({
      mutationFn: ({ fileId, body }: { fileId: string; body: RetainerDepositRequest }) =>
        invoices.deposit(fileId, body),
      onSuccess,
    }),
    pdf: useMutation({ mutationFn: (id: string) => invoices.pdf(id), gcTime: 0 }),
  };
}

/** Follows a download link: storage serves an attachment (D-085), so the page stays (no popup blocker). */
export function openDownload(url: string): void {
  const link = window.document.createElement('a');
  link.href = url;
  link.rel = 'noopener noreferrer';
  link.click();
}
