import type { Invoice, InvoiceListItem } from '@nexlegtiq/shared-contracts';
import { roundMoney } from '@nexlegtiq/shared-utils';

import type { Prisma } from '../../generated/prisma/client';
import { toDbDate } from '../tasks/tasks.repository';

export const LISTED = {
  id: true,
  invoiceNumber: true,
  status: true,
  currency: true,
  issueDate: true,
  dueDate: true,
  subtotal: true,
  taxRatePercent: true,
  taxAmount: true,
  total: true,
  sentAt: true,
  paidAt: true,
  createdAt: true,
  updatedAt: true,
  client: { select: { id: true, displayName: true } },
  file: { select: { id: true, fileNumber: true, title: true } },
} as const;

export const DETAIL = {
  ...LISTED,
  paymentMethod: true,
  paymentReference: true,
  notes: true,
  lines: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      timeEntryId: true,
      description: true,
      quantity: true,
      unitPrice: true,
      amount: true,
    },
  },
} as const satisfies Prisma.InvoiceSelect;

type ListedRow = Prisma.InvoiceGetPayload<{ select: typeof LISTED }>;
type DetailRow = Prisma.InvoiceGetPayload<{ select: typeof DETAIL }>;

export const day = (value: Date) => value.toISOString().slice(0, 10);
export const plusDays = (date: string, days: number) =>
  new Date(toDbDate(date).getTime() + days * 86_400_000).toISOString().slice(0, 10);

/** Amounts leave the API as strings with the currency's own minor digits (ILS 2, JOD 3). */
export function toListItem(row: ListedRow): InvoiceListItem {
  const money = (value: Prisma.Decimal) => roundMoney(value.toFixed(), row.currency);
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    status: row.status,
    client: row.client,
    file: row.file,
    currency: row.currency,
    issueDate: row.issueDate ? day(row.issueDate) : null,
    dueDate: row.dueDate ? day(row.dueDate) : null,
    subtotal: money(row.subtotal),
    taxRatePercent: row.taxRatePercent.toFixed(2),
    taxAmount: money(row.taxAmount),
    total: money(row.total),
    sentAt: row.sentAt?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toInvoice(row: DetailRow): Invoice {
  return {
    ...toListItem(row),
    paymentMethod: row.paymentMethod,
    paymentReference: row.paymentReference,
    notes: row.notes,
    lines: row.lines.map((line) => ({
      id: line.id,
      description: line.description,
      quantity: line.quantity.toFixed(2),
      unitPrice: line.unitPrice.toFixed(3),
      amount: roundMoney(line.amount.toFixed(), row.currency),
      timeEntryId: line.timeEntryId,
    })),
  };
}
