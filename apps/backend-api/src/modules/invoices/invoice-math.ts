import { addMoney, multiplyMoney, percentOf, roundMoney } from '@nexlegtiq/shared-utils';

/** A line's amount: quantity × unit price, rounded once, half-even, to the currency's own minor digits (D-017, D-162). */
export const lineAmount = (quantity: string, unitPrice: string, currency: string): string =>
  roundMoney(multiplyMoney(quantity, unitPrice), currency);

export interface InvoiceTotals {
  readonly subtotal: string;
  readonly taxRatePercent: string;
  readonly taxAmount: string;
  readonly total: string;
}

/**
 * Prices are tax-exclusive: the subtotal is the sum of the (already rounded) line amounts, tax is the rate applied once
 * to the subtotal and rounded to the currency, total = subtotal + tax. Without tax the stored rate is 0 (D-162).
 */
export function invoiceTotals(
  amounts: readonly string[],
  officeTaxRatePercent: string,
  includeTax: boolean,
  currency: string,
): InvoiceTotals {
  const subtotal = roundMoney(addMoney('0', ...amounts), currency);
  const rate = includeTax ? officeTaxRatePercent : '0';
  const taxAmount = roundMoney(percentOf(subtotal, rate), currency);
  return {
    subtotal,
    taxRatePercent: roundMoney(rate, 2),
    taxAmount,
    total: roundMoney(addMoney(subtotal, taxAmount), currency),
  };
}

/** `INV-{YEAR}-{SEQ:4}`; the sequence grows past four digits. */
export const invoiceNumber = (year: number, seq: number): string =>
  `INV-${year}-${String(seq).padStart(4, '0')}`;

export interface BillableEntry {
  readonly id: string;
  readonly fileId: string;
  readonly description: string;
  /** Decimal strings: hours with 2 digits, rate with 3. */
  readonly quantity: string;
  readonly unitPrice: string;
}

export interface ExtraLine {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
}

/** Time lines (one per entry, in order) then the extra items, each amount rounded to the currency. */
export function buildLines(
  entries: readonly BillableEntry[],
  extras: readonly ExtraLine[],
  currency: string,
) {
  return [
    ...entries.map((entry) => ({
      fileId: entry.fileId as string | null,
      timeEntryId: entry.id as string | null,
      description: entry.description,
      quantity: entry.quantity,
      unitPrice: entry.unitPrice,
      amount: lineAmount(entry.quantity, entry.unitPrice, currency),
    })),
    ...extras.map((line) => ({
      fileId: null as string | null,
      timeEntryId: null as string | null,
      ...line,
      amount: lineAmount(line.quantity, line.unitPrice, currency),
    })),
  ];
}
