import { INVOICE_PAYMENT_METHODS, INVOICE_STATUSES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { longText, plainText, sortParam } from './fields.js';

const DateOnlySchema = z.iso.date();
const IsoDateTime = z.iso.datetime({ offset: true, error: 'validation.dateTime' });

/** Quantity (hours, units): above 0, at most 6 integer and 2 decimal digits (`Decimal(8,2)`). */
const QuantitySchema = z
  .string()
  .trim()
  .regex(/^\d{1,6}(\.\d{1,2})?$/, 'validation.quantity')
  .refine((value) => Number(value) > 0, 'validation.quantity');

/** A unit price as a decimal string (D-017): up to 3 decimals (JOD), rounded to the currency when the line is made. */
const PriceSchema = z
  .string()
  .trim()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'validation.price');

/** An extra item on an invoice (a court fee, a disbursement): not tied to a time entry. */
export const InvoiceExtraLineSchema = z.object({
  description: plainText(500),
  quantity: QuantitySchema,
  unitPrice: PriceSchema,
});
export type InvoiceExtraLine = z.infer<typeof InvoiceExtraLineSchema>;

const ExtraLinesSchema = z.array(InvoiceExtraLineSchema).max(50, 'validation.tooLong');

/**
 * `POST /invoices` (D-162): a DRAFT from the client's unbilled billable time in `[periodStart, periodEnd]` (work dates,
 * inclusive) on one file, or on all the client's files when `fileId` is omitted. Prices are tax-exclusive; tax is the
 * office's rate applied once to the subtotal unless `includeTax` is false. `dueDate` defaults to 30 days after sending.
 */
export const CreateInvoiceSchema = z
  .object({
    clientId: z.uuid(),
    fileId: z.uuid().nullish(),
    periodStart: DateOnlySchema,
    periodEnd: DateOnlySchema,
    includeTax: z.boolean().default(true),
    dueDate: DateOnlySchema.optional(),
    extraLines: ExtraLinesSchema.default([]),
    notes: longText(2000).optional(),
  })
  .refine((body) => body.periodStart <= body.periodEnd, {
    path: ['periodEnd'],
    message: 'validation.dateRange',
  });
export type CreateInvoiceRequest = z.input<typeof CreateInvoiceSchema>;
/** The validated body (defaults applied). */
export type CreateInvoiceBody = z.infer<typeof CreateInvoiceSchema>;

/** `PATCH /invoices/:id` (DRAFT only). `extraLines` replaces the draft's extra items; time lines stay. */
export const UpdateInvoiceSchema = z
  .object({
    notes: longText(2000).nullable(),
    dueDate: DateOnlySchema,
    includeTax: z.boolean(),
    extraLines: ExtraLinesSchema,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'validation.required');
export type UpdateInvoiceRequest = z.infer<typeof UpdateInvoiceSchema>;

/** `POST /invoices/:id/mark-paid`. */
export const MarkInvoicePaidSchema = z.object({
  paidAt: IsoDateTime,
  method: z.enum(INVOICE_PAYMENT_METHODS),
  reference: plainText(200).optional(),
});
export type MarkInvoicePaidRequest = z.infer<typeof MarkInvoicePaidSchema>;

export const INVOICE_SORT_FIELDS = ['createdAt', 'issueDate', 'dueDate', 'total'] as const;

/** `GET /invoices`: filters (`from`/`to` on the issue date, inclusive), `sort`, `page`, `limit` ≤ 100. */
export const InvoiceQuerySchema = z
  .object({
    status: z.enum(INVOICE_STATUSES).optional(),
    clientId: z.uuid().optional(),
    fileId: z.uuid().optional(),
    from: DateOnlySchema.optional(),
    to: DateOnlySchema.optional(),
    sort: sortParam(INVOICE_SORT_FIELDS).default([{ field: 'createdAt', direction: 'desc' }]),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    path: ['to'],
    message: 'validation.dateRange',
  });
export type InvoiceQuery = z.infer<typeof InvoiceQuerySchema>;

/** `GET /invoices/summary?clientId=` (MVP-55): totals of the invoices the caller may see. */
export const InvoiceSummaryQuerySchema = z.object({ clientId: z.uuid() });
export type InvoiceSummaryQuery = z.infer<typeof InvoiceSummaryQuerySchema>;

const CurrencyTotalSchema = z.object({
  currency: z.string(),
  amount: z.string(),
  count: z.number().int(),
});

/** Per currency (never added across currencies): billed = sent, overdue or paid; outstanding = sent or overdue. */
export const InvoiceSummarySchema = z.object({
  billed: z.array(CurrencyTotalSchema),
  outstanding: z.array(CurrencyTotalSchema),
});
export type InvoiceSummary = z.infer<typeof InvoiceSummarySchema>;

export const InvoiceLineSchema = z.object({
  id: z.uuid(),
  description: z.string(),
  quantity: z.string(),
  unitPrice: z.string(),
  amount: z.string(),
  /** The time entry this line bills; null for an extra item. */
  timeEntryId: z.uuid().nullable(),
});
export type InvoiceLine = z.infer<typeof InvoiceLineSchema>;

/**
 * An invoice. Amounts are decimal strings with the currency's own minor digits (ILS 2, JOD 3). The number, issue date and
 * due date are set when it is sent (null before). `file` is null for a consolidated invoice.
 */
export const InvoiceListItemSchema = z.object({
  id: z.uuid(),
  invoiceNumber: z.string().nullable(),
  status: z.enum(INVOICE_STATUSES),
  client: z.object({ id: z.uuid(), displayName: z.string() }),
  file: z.object({ id: z.uuid(), fileNumber: z.string(), title: z.string() }).nullable(),
  currency: z.string(),
  issueDate: DateOnlySchema.nullable(),
  dueDate: DateOnlySchema.nullable(),
  subtotal: z.string(),
  taxRatePercent: z.string(),
  taxAmount: z.string(),
  total: z.string(),
  sentAt: z.iso.datetime().nullable(),
  paidAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type InvoiceListItem = z.infer<typeof InvoiceListItemSchema>;

export const InvoiceSchema = InvoiceListItemSchema.extend({
  paymentMethod: z.enum(INVOICE_PAYMENT_METHODS).nullable(),
  paymentReference: z.string().nullable(),
  notes: z.string().nullable(),
  lines: z.array(InvoiceLineSchema),
});
export type Invoice = z.infer<typeof InvoiceSchema>;

/** Languages an invoice PDF is written in (MVP-92); the office's default when not chosen (BILINGUAL → Arabic). */
export const INVOICE_PDF_LANGUAGES = ['AR', 'EN'] as const;
const PdfLanguageSchema = z.enum(INVOICE_PDF_LANGUAGES);

/** `POST /invoices/:id/send` (optional body): email the PDF to the client's primary contact. */
export const SendInvoiceSchema = z
  .object({ emailClient: z.boolean().default(false), language: PdfLanguageSchema.optional() })
  .default({ emailClient: false });
export type SendInvoiceRequest = z.infer<typeof SendInvoiceSchema>;

/** `GET /invoices/:id/pdf?language=`. */
export const InvoicePdfQuerySchema = z.object({ language: PdfLanguageSchema.optional() });
export type InvoicePdfQuery = z.infer<typeof InvoicePdfQuerySchema>;

/** 200 with a short-lived link when the PDF of the invoice as it is now exists; 202 while the worker renders it. */
export const InvoicePdfSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('READY'), downloadUrl: z.url(), expiresIn: z.number().int() }),
  z.object({ status: z.literal('RENDERING') }),
]);
export type InvoicePdf = z.infer<typeof InvoicePdfSchema>;
