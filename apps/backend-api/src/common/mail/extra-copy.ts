import { INVOICE_COPY, INVOICE_VARS } from './invoice-copy';
import { RECEIPT_COPY, RECEIPT_VARS } from './receipt-copy';
import { TASK_DIGEST_COPY, TASK_DIGEST_VARS } from './task-copy';

/** Templates kept apart from templates.ts (its length limit): variables and copy, registered there by spreading. */
export const EXTRA_VARS = {
  invoice: INVOICE_VARS,
  'payment-receipt': RECEIPT_VARS,
  'task-digest': TASK_DIGEST_VARS,
} as const;

/** Subject, html and text of each locale (the shape of every copy file). */
type Copies = Readonly<
  Record<'AR' | 'EN', { readonly subject: string; readonly html: string; readonly text: string }>
>;

export const EXTRA_COPY: Readonly<Record<keyof typeof EXTRA_VARS, Copies>> = {
  invoice: INVOICE_COPY,
  'payment-receipt': RECEIPT_COPY,
  'task-digest': TASK_DIGEST_COPY,
} as const;
