import { formatDate, formatMoney } from '@nexlegtiq/shared-utils';

import { esc, fontFaces } from '../invoices/pdf/invoice-pdf.html';
import type { PdfLanguage } from '../invoices/pdf/invoice-pdf.html';

/** Everything the receipt shows (amount as a decimal string, date `YYYY-MM-DD`). */
export interface ReceiptPdfData {
  readonly language: PdfLanguage;
  readonly receiptNumber: string;
  readonly paidAt: string;
  readonly amount: string;
  readonly currency: string;
  readonly method: 'CASH' | 'BANK_TRANSFER' | 'OTHER';
  readonly reference: string | null;
  readonly voided: boolean;
  readonly issuer: {
    readonly name: string;
    readonly address: string | null;
    readonly taxId: string | null;
  };
  readonly office: {
    readonly name: string;
    readonly address: string | null;
    readonly email: string | null;
  };
}

const COPY = {
  AR: {
    title: 'إيصال دفع',
    notInvoice: 'هذا إيصال دفع وليس فاتورة ضريبية.',
    number: 'رقم الإيصال',
    date: 'تاريخ الدفع',
    from: 'استلمنا من',
    amount: 'المبلغ المستلم',
    method: 'طريقة الدفع',
    reference: 'المرجع',
    taxId: 'رقم التسجيل / الرقم الضريبي',
    VOID: 'ملغى',
    methods: { CASH: 'نقدًا', BANK_TRANSFER: 'تحويل بنكي', OTHER: 'أخرى' },
  },
  EN: {
    title: 'Payment receipt',
    notInvoice: 'This is a payment receipt, not a tax invoice.',
    number: 'Receipt number',
    date: 'Payment date',
    from: 'Received from',
    amount: 'Amount received',
    method: 'Payment method',
    reference: 'Reference',
    taxId: 'Registration / tax no.',
    VOID: 'Void',
    methods: { CASH: 'Cash', BANK_TRANSFER: 'Bank transfer', OTHER: 'Other' },
  },
} as const;

const ltr = (value: string) => `<bdi dir="ltr">${esc(value)}</bdi>`;
const lines = (values: readonly (string | null)[]) =>
  values
    .filter((v): v is string => Boolean(v))
    .map((v) => `<div>${v}</div>`)
    .join('');

/** A plain payment receipt (owner 1A): no VAT line; Arabic RTL or English LTR, numbers and codes left-to-right. */
export function receiptHtml(data: ReceiptPdfData): string {
  const t = COPY[data.language];
  const locale = data.language === 'AR' ? 'ar' : 'en';
  const { issuer, office } = data;
  const row = (label: string, value: string) => `<tr><th>${esc(label)}</th><td>${value}</td></tr>`;
  return `<!doctype html>
<html lang="${locale}" dir="${data.language === 'AR' ? 'rtl' : 'ltr'}">
<head><meta charset="utf-8"><title>${esc(t.title)}</title>
<style>
${fontFaces()}
@page{size:A4;margin:16mm 14mm;}
*{box-sizing:border-box;}
body{margin:0;font-family:NexLatin,NexArabic,sans-serif;font-size:10.5pt;line-height:1.6;color:#1f2933;}
header{display:flex;justify-content:space-between;gap:24px;border-block-end:2px solid #1f3a5f;padding-block-end:12px;}
h1{margin:0;font-size:22pt;color:#1f3a5f;}
.issuer{font-weight:700;font-size:13pt;}
.muted{color:#52606d;}
table{width:100%;border-collapse:collapse;margin-block-start:20px;}
th{text-align:start;width:35%;padding:8px;background:#eef2f7;font-weight:700;color:#1f3a5f;}
td{padding:8px;border-block-end:1px solid #e4e7eb;}
.amount td{font-weight:700;font-size:14pt;}
.note{margin-block-start:24px;color:#52606d;}
.stamp{display:inline-block;margin-block-start:8px;padding:4px 12px;border:2px solid;font-weight:700;font-size:13pt;color:#b42318;}
</style></head>
<body>
<header>
<div><div class="issuer">${esc(issuer.name)}</div>
<div class="muted">${lines([
    issuer.address && esc(issuer.address),
    issuer.taxId && `${esc(t.taxId)}: ${ltr(issuer.taxId)}`,
  ])}</div></div>
<div><h1>${esc(t.title)}</h1>
<div>${esc(t.number)}: ${ltr(data.receiptNumber)}</div>
${data.voided ? `<div class="stamp">${esc(t.VOID)}</div>` : ''}</div>
</header>
<table>
${row(t.from, `<bdi>${esc(office.name)}</bdi>${lines([office.address && esc(office.address), office.email && ltr(office.email)])}`)}
${row(t.date, `<bdi>${esc(formatDate(data.paidAt, { locale }))}</bdi>`)}
<tr class="amount"><th>${esc(t.amount)}</th><td><bdi>${esc(formatMoney(data.amount, data.currency, { locale }))}</bdi></td></tr>
${row(t.method, esc(t.methods[data.method]))}
${data.reference ? row(t.reference, ltr(data.reference)) : ''}
</table>
<p class="note">${esc(t.notInvoice)}</p>
</body></html>`;
}
