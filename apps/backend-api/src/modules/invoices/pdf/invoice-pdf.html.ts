import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { formatDate, formatMoney, formatNumber } from '@nexlegtiq/shared-utils';

export type PdfLanguage = 'AR' | 'EN';

/** Everything the PDF shows, already read from the invoice (amounts as decimal strings, dates `YYYY-MM-DD`). */
export interface InvoicePdfData {
  readonly language: PdfLanguage;
  /** PAID and VOID are stamped on the page; other states print as the invoice. */
  readonly status: string;
  readonly invoiceNumber: string | null;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly currency: string;
  readonly subtotal: string;
  readonly taxRatePercent: string;
  readonly taxAmount: string;
  readonly total: string;
  readonly notes: string | null;
  readonly office: {
    readonly name: string;
    readonly address: string | null;
    readonly phone: string | null;
    readonly email: string | null;
    readonly taxId: string | null;
    readonly registrationNumber: string | null;
  };
  readonly client: {
    readonly name: string;
    readonly address: string | null;
    readonly phone: string | null;
    readonly email: string | null;
  };
  readonly file: { readonly fileNumber: string; readonly title: string } | null;
  readonly lines: readonly {
    readonly description: string;
    readonly quantity: string;
    readonly unitPrice: string;
    readonly amount: string;
  }[];
}

const COPY = {
  AR: {
    title: 'فاتورة',
    draft: 'مسودة — غير مرقّمة',
    PAID: 'مدفوعة',
    VOID: 'ملغاة — لا يُطالب بها',
    number: 'رقم الفاتورة',
    issued: 'تاريخ الإصدار',
    due: 'تاريخ الاستحقاق',
    billTo: 'إلى',
    file: 'الملف',
    description: 'البيان',
    quantity: 'الكمية',
    unitPrice: 'سعر الوحدة',
    amount: 'المبلغ',
    subtotal: 'المجموع قبل الضريبة',
    tax: 'الضريبة',
    total: 'الإجمالي المستحق',
    notes: 'ملاحظات',
    taxId: 'الرقم الضريبي',
    registration: 'رقم التسجيل',
  },
  EN: {
    title: 'Invoice',
    draft: 'Draft — not numbered',
    PAID: 'Paid',
    VOID: 'Void — not payable',
    number: 'Invoice number',
    issued: 'Issue date',
    due: 'Due date',
    billTo: 'Bill to',
    file: 'File',
    description: 'Description',
    quantity: 'Quantity',
    unitPrice: 'Unit price',
    amount: 'Amount',
    subtotal: 'Subtotal',
    tax: 'Tax',
    total: 'Total due',
    notes: 'Notes',
    taxId: 'Tax ID',
    registration: 'Registration no.',
  },
} as const;

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
/** Every value from the database goes through here: the page is printed by a browser. */
export const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

// Resolved at run time from the app directory: webpack would otherwise try to bundle the font files.
const fromCwd = createRequire(join(process.cwd(), 'noop.js'));
let fonts: string | undefined;
/** Self-hosted fonts (D-088) embedded as data URIs: Chromium needs no network and no system fonts. */
function fontFaces(): string {
  fonts ??= [
    [
      'NexArabic',
      '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-400-normal.woff2',
      400,
    ],
    [
      'NexArabic',
      '@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-700-normal.woff2',
      700,
    ],
    ['NexLatin', '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', '100 900'],
  ]
    .map(([family, path, weight]) => {
      const data = readFileSync(fromCwd.resolve(String(path))).toString('base64');
      return `@font-face{font-family:${family};font-weight:${weight};src:url(data:font/woff2;base64,${data}) format('woff2');}`;
    })
    .join('\n');
  return fonts;
}

type Copy = (typeof COPY)[PdfLanguage];
const ltr = (value: string) => `<bdi dir="ltr">${esc(value)}</bdi>`;
/** One line per value that is set; the values are already escaped. */
const lines = (values: readonly (string | null)[]) =>
  values
    .filter((v): v is string => Boolean(v))
    .map((v) => `<div>${v}</div>`)
    .join('');

function officeLines(office: InvoicePdfData['office'], t: Copy): string {
  return lines([
    office.address && esc(office.address),
    office.phone && ltr(office.phone),
    office.email && ltr(office.email),
    office.taxId && `${esc(t.taxId)}: ${ltr(office.taxId)}`,
    office.registrationNumber && `${esc(t.registration)}: ${ltr(office.registrationNumber)}`,
  ]);
}

function clientLines(client: InvoicePdfData['client']): string {
  return lines([
    client.address && esc(client.address),
    client.phone && ltr(client.phone),
    client.email && ltr(client.email),
  ]);
}

const fileSection = (file: InvoicePdfData['file'], t: Copy) =>
  file
    ? `<section><div class="label">${esc(t.file)}</div><div>${ltr(file.fileNumber)} — ${esc(file.title)}</div></section>`
    : '';
const stamp = (status: string, t: Copy) =>
  status === 'PAID' || status === 'VOID'
    ? `<div class="stamp ${status.toLowerCase()}">${esc(t[status as 'PAID' | 'VOID'])}</div>`
    : '';
const notesBlock = (notes: string | null, t: Copy) =>
  notes ? `<div class="notes"><div class="label">${esc(t.notes)}</div>${esc(notes)}</div>` : '';

/** The invoice as one printable A4 page set, in Arabic (RTL) or English (LTR); numbers and codes stay left-to-right. */
export function invoiceHtml(data: InvoicePdfData): string {
  const t = COPY[data.language];
  const locale = data.language === 'AR' ? 'ar' : 'en';
  const money = (value: string) =>
    `<bdi>${esc(formatMoney(value, data.currency, { locale }))}</bdi>`;
  const date = (value: string | null) =>
    value ? `<bdi>${esc(formatDate(value, { locale }))}</bdi>` : '—';
  const percent = esc(formatNumber(data.taxRatePercent, { locale, maximumFractionDigits: 2 }));
  const taxRow =
    Number(data.taxAmount) > 0
      ? `<tr><td>${esc(t.tax)} (<bdi>${percent}%</bdi>)</td><td class="num">${money(data.taxAmount)}</td></tr>`
      : '';
  const { office, client } = data;
  const rows = data.lines
    .map(
      (line) => `<tr><td class="desc">${esc(line.description)}</td>
<td class="num"><bdi>${esc(formatNumber(line.quantity, { locale, maximumFractionDigits: 2 }))}</bdi></td>
<td class="num">${money(line.unitPrice)}</td><td class="num">${money(line.amount)}</td></tr>`,
    )
    .join('\n');
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
.office{font-weight:700;font-size:13pt;}
.muted{color:#52606d;}
.meta{display:grid;grid-template-columns:auto auto;gap:2px 16px;align-content:start;}
.parties{display:flex;gap:24px;margin-block:16px;}
.parties section{flex:1;}
.label{font-weight:700;color:#1f3a5f;}
table{width:100%;border-collapse:collapse;margin-block-start:8px;}
th{background:#eef2f7;text-align:start;padding:6px 8px;font-weight:700;}
td{padding:6px 8px;border-block-end:1px solid #e4e7eb;vertical-align:top;}
.num{text-align:end;white-space:nowrap;}
.desc{white-space:pre-wrap;}
tr{break-inside:avoid;}
.totals{margin-inline-start:auto;width:50%;margin-block-start:12px;}
.totals td{border:none;padding:3px 8px;}
.grand td{font-weight:700;font-size:12pt;border-block-start:2px solid #1f3a5f;}
.notes{margin-block-start:20px;white-space:pre-wrap;unicode-bidi:plaintext;}
.stamp{display:inline-block;margin-block-start:8px;padding:4px 12px;border:2px solid;font-weight:700;font-size:13pt;}
.stamp.paid{color:#1e7b45;}
.stamp.void{color:#b42318;}
</style></head>
<body>
<header>
<div><div class="office">${esc(office.name)}</div>
<div class="muted">${officeLines(office, t)}</div></div>
<div><h1>${esc(t.title)}</h1>
<div class="meta">
<span class="label">${esc(t.number)}</span><span>${data.invoiceNumber ? ltr(data.invoiceNumber) : esc(t.draft)}</span>
<span class="label">${esc(t.issued)}</span><span>${date(data.issueDate)}</span>
<span class="label">${esc(t.due)}</span><span>${date(data.dueDate)}</span>
</div>${stamp(data.status, t)}</div>
</header>
<div class="parties">
<section><div class="label">${esc(t.billTo)}</div><div>${esc(client.name)}</div>
<div class="muted">${clientLines(client)}</div></section>
${fileSection(data.file, t)}
</div>
<table>
<thead><tr><th>${esc(t.description)}</th><th class="num">${esc(t.quantity)}</th><th class="num">${esc(t.unitPrice)}</th><th class="num">${esc(t.amount)}</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
<table class="totals">
<tr><td>${esc(t.subtotal)}</td><td class="num">${money(data.subtotal)}</td></tr>
${taxRow}
<tr class="grand"><td>${esc(t.total)}</td><td class="num">${money(data.total)}</td></tr>
</table>
${notesBlock(data.notes, t)}
</body></html>`;
}
