/** Invoice lifecycle (D-162). Mirrors the Prisma enum; labels: `enums.invoiceStatus.<VALUE>`. */
export const INVOICE_STATUSES = ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'VOID'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** How an invoice was paid; labels: `enums.invoicePaymentMethod.<VALUE>`. */
export const INVOICE_PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'CARD', 'OTHER'] as const;
export type InvoicePaymentMethod = (typeof INVOICE_PAYMENT_METHODS)[number];
