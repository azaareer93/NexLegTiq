import {
  INVOICE_PAYMENT_METHODS,
  RETAINER_DEPOSIT_METHODS,
  RETAINER_ENTRY_KINDS,
} from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { plainText } from './fields.js';

/**
 * `POST /cases/:id/retainer/deposit` (MVP-147, D-176): money the client paid in advance, in the file's currency. Up to
 * 3 decimals (JOD); the server refuses more than the currency has.
 */
export const RetainerDepositSchema = z.object({
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,11}(\.\d{1,3})?$/, 'validation.amount')
    .refine((value) => Number(value) > 0, 'validation.amount'),
  paidAt: z.iso.datetime({ offset: true, error: 'validation.dateTime' }),
  method: z.enum(RETAINER_DEPOSIT_METHODS),
  reference: plainText(200).optional(),
});
export type RetainerDepositRequest = z.infer<typeof RetainerDepositSchema>;

export const RetainerEntrySchema = z.object({
  id: z.uuid(),
  kind: z.enum(RETAINER_ENTRY_KINDS),
  /** Signed decimal string: a deposit is positive, an invoice payment negative. */
  amount: z.string(),
  paidAt: z.iso.datetime(),
  method: z.enum(INVOICE_PAYMENT_METHODS).nullable(),
  reference: z.string().nullable(),
  invoice: z.object({ id: z.uuid(), invoiceNumber: z.string().nullable() }).nullable(),
  createdBy: z.object({ id: z.uuid(), fullName: z.string() }),
  createdAt: z.iso.datetime(),
});
export type RetainerEntry = z.infer<typeof RetainerEntrySchema>;

/** `GET /cases/:id/retainer`: the balance (the ledger's sum) and the ledger, newest first. */
export const RetainerSchema = z.object({
  fileId: z.uuid(),
  currency: z.string(),
  balance: z.string(),
  /** The newest 100 entries (the balance covers all of them). */
  entries: z.array(RetainerEntrySchema),
});
export type Retainer = z.infer<typeof RetainerSchema>;
