import { z } from 'zod';

/** The company named on payment receipts to offices (D-174); unset address/number lines are left off the receipt. */
export const RECEIPT_ENV = {
  RECEIPT_ISSUER_NAME: z.string().trim().min(1).default('NexLegTiq'),
  RECEIPT_ISSUER_ADDRESS: z.string().trim().min(1).optional(),
  RECEIPT_ISSUER_TAX_ID: z.string().trim().min(1).optional(),
};
