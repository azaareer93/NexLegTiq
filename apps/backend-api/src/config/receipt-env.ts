import { z } from 'zod';

/**
 * Accounting records. The company named on payment receipts to offices (D-174); unset address/number lines are left off
 * the receipt. And how many years a purged office's issued invoices and anonymized audit rows are kept (D-251): 7,
 * pending legal confirmation for Palestine and Jordan.
 */
export const RECEIPT_ENV = {
  RECEIPT_ISSUER_NAME: z.string().trim().min(1).default('NexLegTiq'),
  RECEIPT_ISSUER_ADDRESS: z.string().trim().min(1).optional(),
  RECEIPT_ISSUER_TAX_ID: z.string().trim().min(1).optional(),
  RETAINED_RECORDS_YEARS: z.coerce.number().int().min(1).max(30).default(7),
};
