/** Invoice lifecycle (D-162). Mirrors the Prisma enum; labels: `enums.invoiceStatus.<VALUE>`. */
export const INVOICE_STATUSES = ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** How an invoice was paid; labels: `enums.invoicePaymentMethod.<VALUE>`. */
export const INVOICE_PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'CARD',
  'OTHER',
  'RETAINER',
] as const;
export type InvoicePaymentMethod = (typeof INVOICE_PAYMENT_METHODS)[number];

/** A retainer ledger entry (D-176); labels: `enums.retainerEntryKind.<VALUE>`. */
export const RETAINER_ENTRY_KINDS = ['DEPOSIT', 'INVOICE_PAYMENT'] as const;
export type RetainerEntryKind = (typeof RETAINER_ENTRY_KINDS)[number];

/** How a retainer deposit came in: any payment method but the retainer itself. */
export const RETAINER_DEPOSIT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'CARD',
  'OTHER',
] as const satisfies readonly Exclude<InvoicePaymentMethod, 'RETAINER'>[];
