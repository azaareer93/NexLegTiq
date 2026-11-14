import { PLATFORM_PAYMENT_METHODS } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { CurrencySchema, longText, plainText } from './fields.js';
import { InvoicePdfSchema } from './invoice.contract.js';

/**
 * `POST /admin/offices/:id/payments` (MVP-170, D-174): a cash or bank payment an office made. Up to 3 decimals (JOD);
 * the server refuses more than the currency has. Recording it never changes the subscription (owner 3A).
 */
export const RecordPaymentSchema = z.object({
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,11}(\.\d{1,3})?$/, 'validation.amount')
    .refine((value) => Number(value) > 0, 'validation.amount'),
  currency: CurrencySchema,
  method: z.enum(PLATFORM_PAYMENT_METHODS),
  reference: plainText(100).nullish(),
  /** The day the money was received. */
  paidAt: z.iso.date('validation.date'),
  /** Email the receipt to the office's address (default on). */
  emailOffice: z.boolean().default(true),
});
export type RecordPaymentRequest = z.infer<typeof RecordPaymentSchema>;

/** `POST /admin/payments/:id/void`: a mistaken payment keeps its receipt number (owner 2A). */
export const VoidPaymentSchema = z.object({
  reason: longText(500).min(3, 'validation.tooShort'),
});
export type VoidPaymentRequest = z.infer<typeof VoidPaymentSchema>;

export const AdminPaymentSchema = z.object({
  id: z.uuid(),
  officeId: z.uuid(),
  receiptNumber: z.string(),
  amount: z.string(),
  currency: z.string(),
  method: z.enum(PLATFORM_PAYMENT_METHODS),
  reference: z.string().nullable(),
  paidAt: z.iso.date(),
  recordedBy: z.object({ id: z.uuid(), fullName: z.string() }),
  voidedAt: z.iso.datetime().nullable(),
  voidReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminPayment = z.infer<typeof AdminPaymentSchema>;

/** `GET /admin/payments/:id/receipt`: a short-lived link (200) or a render queued (202), as invoice PDFs (D-171). */
export const PaymentReceiptSchema = InvoicePdfSchema;
export type PaymentReceipt = z.infer<typeof PaymentReceiptSchema>;
