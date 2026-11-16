import { FILE_STATUSES, TIMELINE_EVENT_TYPES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

/**
 * What a client sees on the portal (D-003, D-186). Portal-only shapes, never the office DTOs: a field is here only when a
 * client may see it — no notes, tasks, AI output, other parties, witnesses, audit or staff contact details.
 */

/** The next hearing that is not cancelled and has not started: when and where only. */
export const PortalHearingSchema = z.object({
  startsAt: z.iso.datetime(),
  courtNameAr: z.string().nullable(),
  courtNameEn: z.string().nullable(),
});

/** `GET /portal/files`: one of the client's files, in any office the account may enter. */
export const PortalFileSchema = z.object({
  id: z.uuid(),
  officeId: z.uuid(),
  officeName: z.string(),
  fileNumber: z.string(),
  title: z.string(),
  status: z.enum(FILE_STATUSES),
  /** The responsible lawyer's name only. */
  lawyerName: z.string(),
  nextHearing: PortalHearingSchema.nullable(),
});
export type PortalFile = z.infer<typeof PortalFileSchema>;

/** A public timeline event: its kind and time, never its payload (names, amounts and actors stay inside the office). */
export const PortalTimelineEventSchema = z.object({
  eventType: z.enum(TIMELINE_EVENT_TYPES),
  occurredAt: z.iso.datetime(),
});

/** `GET /portal/files/:id`: the file with its newest 100 public timeline events. */
export const PortalFileDetailSchema = PortalFileSchema.extend({
  timeline: z.array(PortalTimelineEventSchema),
});
export type PortalFileDetail = z.infer<typeof PortalFileDetailSchema>;

/** `GET /portal/files/:id/documents`: a document the office shared, ready to download. */
export const PortalDocumentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  mimeType: z.string(),
  /** Bytes, as text (BigInt). */
  sizeBytes: z.string(),
  createdAt: z.iso.datetime(),
});
export type PortalDocument = z.infer<typeof PortalDocumentSchema>;

/** `GET /portal/invoices` (D-188): an invoice the office shared with the client — sent, overdue or paid, never a draft. */
export const PortalInvoiceSchema = z.object({
  id: z.uuid(),
  officeId: z.uuid(),
  officeName: z.string(),
  invoiceNumber: z.string(),
  status: z.enum(['SENT', 'OVERDUE', 'PAID']),
  currency: z.string(),
  issueDate: z.iso.date(),
  dueDate: z.iso.date(),
  /** In the currency's minor digits, as text. */
  total: z.string(),
  paidAt: z.iso.datetime().nullable(),
  /** The file it bills, when it bills one. */
  file: z.object({ id: z.uuid(), fileNumber: z.string(), title: z.string() }).nullable(),
});
export type PortalInvoice = z.infer<typeof PortalInvoiceSchema>;

/** `GET /portal/invoices/:id/pdf`: 200 with a 5-minute link once rendered, else 202 while the office's worker renders it. */
export const PortalInvoicePdfSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('READY'), downloadUrl: z.url(), expiresIn: z.number().int() }),
  z.object({ status: z.literal('RENDERING') }),
]);
export type PortalInvoicePdf = z.infer<typeof PortalInvoicePdfSchema>;
