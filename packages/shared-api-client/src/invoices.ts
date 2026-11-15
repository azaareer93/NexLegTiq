import {
  InvoiceListItemSchema,
  InvoicePdfSchema,
  InvoiceSchema,
  RetainerSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  CreateInvoiceRequest,
  Invoice,
  InvoiceListItem,
  InvoicePdf,
  MarkInvoicePaidRequest,
  Retainer,
  RetainerDepositRequest,
  SendInvoiceRequest,
  UpdateInvoiceRequest,
} from '@nexlegtiq/shared-contracts';

import type { ApiClient, Page } from './api-client.js';
import type { InvoiceListParams } from './client-profile.js';

/** Invoices (D-162), their PDFs (D-171) and a file's retainer (D-176). */
export function invoicesApi(client: ApiClient) {
  const path = (id: string) => `invoices/${encodeURIComponent(id)}`;
  const retainer = (fileId: string) => `cases/${encodeURIComponent(fileId)}/retainer`;
  return {
    list: (query: InvoiceListParams, signal?: AbortSignal): Promise<Page<InvoiceListItem>> =>
      client.requestPage({ method: 'GET', path: 'invoices', query, signal }, InvoiceListItemSchema),
    get: (id: string, signal?: AbortSignal): Promise<Invoice> =>
      client.request({ method: 'GET', path: path(id), signal }, InvoiceSchema),
    /** A DRAFT from the client's unbilled time in the period (and extra lines). */
    create: (body: CreateInvoiceRequest): Promise<Invoice> =>
      client.request({ method: 'POST', path: 'invoices', body }, InvoiceSchema),
    update: (id: string, body: UpdateInvoiceRequest): Promise<Invoice> =>
      client.request({ method: 'PATCH', path: path(id), body }, InvoiceSchema),
    /** A draft only; its entries are free to bill again. */
    remove: (id: string): Promise<void> => client.request({ method: 'DELETE', path: path(id) }),
    send: (id: string, body: SendInvoiceRequest = { emailClient: false }): Promise<Invoice> =>
      client.request({ method: 'POST', path: `${path(id)}/send`, body }, InvoiceSchema),
    markPaid: (id: string, body: MarkInvoicePaidRequest): Promise<Invoice> =>
      client.request({ method: 'POST', path: `${path(id)}/mark-paid`, body }, InvoiceSchema),
    void: (id: string): Promise<Invoice> =>
      client.request({ method: 'POST', path: `${path(id)}/void` }, InvoiceSchema),
    /** READY with a short-lived link, or RENDERING (202): ask again shortly. */
    pdf: (id: string): Promise<InvoicePdf> =>
      client.request({ method: 'GET', path: `${path(id)}/pdf` }, InvoicePdfSchema),
    retainer: (fileId: string, signal?: AbortSignal): Promise<Retainer> =>
      client.request({ method: 'GET', path: retainer(fileId), signal }, RetainerSchema),
    deposit: (fileId: string, body: RetainerDepositRequest): Promise<Retainer> =>
      client.request({ method: 'POST', path: `${retainer(fileId)}/deposit`, body }, RetainerSchema),
  };
}
