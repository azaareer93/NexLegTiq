import {
  ClientDocumentSchema,
  InvoiceListItemSchema,
  InvoiceSummarySchema,
  NoteSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  ClientDocument,
  ClientDocumentQuerySchema,
  CreateNoteRequest,
  InvoiceListItem,
  InvoiceQuerySchema,
  InvoiceSummary,
  Note,
  UpdateNoteRequest,
} from '@nexlegtiq/shared-contracts';
import type { z } from 'zod';

import type { ApiClient, Page } from './api-client.js';

/** `GET /clients/:id/documents` parameters as they travel in the query string. */
export type ClientDocumentListParams = Partial<
  Record<keyof z.input<typeof ClientDocumentQuerySchema>, string>
>;
/** `GET /invoices` parameters as they travel in the query string. */
export type InvoiceListParams = Partial<Record<keyof z.input<typeof InvoiceQuerySchema>, string>>;

/** What the client profile reads beyond the client itself (MVP-55): notes (D-168), documents and invoices. */
export function clientProfileApi(client: ApiClient) {
  const path = (id: string) => `clients/${encodeURIComponent(id)}`;
  const note = (id: string, noteId: string) => `${path(id)}/notes/${encodeURIComponent(noteId)}`;
  return {
    notes: (id: string, signal?: AbortSignal): Promise<Note[]> =>
      client.request({ method: 'GET', path: `${path(id)}/notes`, signal }, NoteSchema.array()),
    addNote: (id: string, body: CreateNoteRequest): Promise<Note> =>
      client.request({ method: 'POST', path: `${path(id)}/notes`, body }, NoteSchema),
    updateNote: (id: string, noteId: string, body: UpdateNoteRequest): Promise<Note> =>
      client.request({ method: 'PATCH', path: note(id, noteId), body }, NoteSchema),
    removeNote: (id: string, noteId: string): Promise<void> =>
      client.request({ method: 'DELETE', path: note(id, noteId) }),
    documents: (
      id: string,
      query: ClientDocumentListParams,
      signal?: AbortSignal,
    ): Promise<Page<ClientDocument>> =>
      client.requestPage(
        { method: 'GET', path: `${path(id)}/documents`, query, signal },
        ClientDocumentSchema,
      ),
    invoices: (query: InvoiceListParams, signal?: AbortSignal): Promise<Page<InvoiceListItem>> =>
      client.requestPage({ method: 'GET', path: 'invoices', query, signal }, InvoiceListItemSchema),
    invoiceSummary: (clientId: string, signal?: AbortSignal): Promise<InvoiceSummary> =>
      client.request(
        { method: 'GET', path: 'invoices/summary', query: { clientId }, signal },
        InvoiceSummarySchema,
      ),
  };
}
