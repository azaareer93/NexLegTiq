import { z } from 'zod';

// First Strong Isolate / Pop Directional Isolate, as in templates.ts: user values keep their own direction.
const iso = (variable: string) => `⁨{{${variable}}}⁩`;

/** Variables of the invoice email; `dueDate` is formatted by the sender, empty when the invoice has none. */
export const INVOICE_VARS = z.object({
  officeName: z.string().trim().min(1).max(200),
  clientName: z.string().trim().min(1).max(200),
  invoiceNumber: z.string().trim().min(1).max(64),
  dueDate: z.string().trim().max(100),
});

interface Copy {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** The invoice email (MVP-92, D-171): no button, the PDF is attached. Apart from templates.ts to keep that file short. */
export const INVOICE_COPY: Readonly<Record<'AR' | 'EN', Copy>> = {
  AR: {
    subject: `فاتورة ${iso('invoiceNumber')} من ${iso('officeName')}`,
    html: `<p>مرحبًا <bdi>{{clientName}}</bdi>،</p>
<p>تجد مرفقًا الفاتورة رقم <bdi dir="ltr">{{invoiceNumber}}</bdi> من <bdi>{{officeName}}</bdi>.{{#if dueDate}} تاريخ الاستحقاق: <bdi>{{dueDate}}</bdi>.{{/if}}</p>
<p>لأي استفسار عن الفاتورة يُرجى التواصل مع المكتب مباشرة.</p>`,
    text: `مرحبًا ${iso('clientName')}،

تجد مرفقًا الفاتورة رقم ${iso('invoiceNumber')} من ${iso('officeName')}.{{#if dueDate}} تاريخ الاستحقاق: ${iso('dueDate')}.{{/if}}

لأي استفسار عن الفاتورة يُرجى التواصل مع المكتب مباشرة.`,
  },
  EN: {
    subject: `Invoice ${iso('invoiceNumber')} from ${iso('officeName')}`,
    html: `<p>Hello <bdi>{{clientName}}</bdi>,</p>
<p>Please find attached invoice <bdi dir="ltr">{{invoiceNumber}}</bdi> from <bdi>{{officeName}}</bdi>.{{#if dueDate}} Due date: <bdi>{{dueDate}}</bdi>.{{/if}}</p>
<p>For any question about this invoice, please contact the office directly.</p>`,
    text: `Hello ${iso('clientName')},

Please find attached invoice ${iso('invoiceNumber')} from ${iso('officeName')}.{{#if dueDate}} Due date: ${iso('dueDate')}.{{/if}}

For any question about this invoice, please contact the office directly.`,
  },
};
