import { z } from 'zod';

// First Strong Isolate / Pop Directional Isolate, as in templates.ts: user values keep their own direction.
const iso = (variable: string) => `⁨{{${variable}}}⁩`;

/** Variables of the payment receipt email (MVP-170, D-174); `amount` is formatted by the sender. */
export const RECEIPT_VARS = z.object({
  issuerName: z.string().trim().min(1).max(200),
  officeName: z.string().trim().min(1).max(200),
  receiptNumber: z.string().trim().min(1).max(64),
  amount: z.string().trim().min(1).max(100),
});

interface Copy {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** The payment receipt sent to an office: no button, the PDF is attached. */
export const RECEIPT_COPY: Readonly<Record<'AR' | 'EN', Copy>> = {
  AR: {
    subject: `إيصال دفع ${iso('receiptNumber')} من ${iso('issuerName')}`,
    html: `<p>مرحبًا <bdi>{{officeName}}</bdi>،</p>
<p>شكرًا لكم. استلمنا دفعتكم بمبلغ <bdi>{{amount}}</bdi>، وتجدون مرفقًا إيصال الدفع رقم <bdi dir="ltr">{{receiptNumber}}</bdi>.</p>
<p>هذا إيصال دفع وليس فاتورة ضريبية.</p>`,
    text: `مرحبًا ${iso('officeName')}،

شكرًا لكم. استلمنا دفعتكم بمبلغ ${iso('amount')}، وتجدون مرفقًا إيصال الدفع رقم ${iso('receiptNumber')}.

هذا إيصال دفع وليس فاتورة ضريبية.`,
  },
  EN: {
    subject: `Payment receipt ${iso('receiptNumber')} from ${iso('issuerName')}`,
    html: `<p>Hello <bdi>{{officeName}}</bdi>,</p>
<p>Thank you. We received your payment of <bdi>{{amount}}</bdi>; payment receipt <bdi dir="ltr">{{receiptNumber}}</bdi> is attached.</p>
<p>This is a payment receipt, not a tax invoice.</p>`,
    text: `Hello ${iso('officeName')},

Thank you. We received your payment of ${iso('amount')}; payment receipt ${iso('receiptNumber')} is attached.

This is a payment receipt, not a tax invoice.`,
  },
};
