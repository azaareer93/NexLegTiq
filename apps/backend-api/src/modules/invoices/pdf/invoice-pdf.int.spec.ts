import { extractText, getDocumentProxy } from 'unpdf';

import { printPdf } from './chromium';
import { canPrint, TEST_CHROMIUM as chromium } from './chromium.test-helper';
import { invoiceHtml } from './invoice-pdf.html';
import type { InvoicePdfData } from './invoice-pdf.html';

const itPrints = canPrint ? it : it.skip;

const SAMPLE: InvoicePdfData = {
  language: 'AR',
  status: 'SENT',
  invoiceNumber: 'INV-2026-0007',
  issueDate: '2026-11-14',
  dueDate: '2026-12-14',
  currency: 'ILS',
  subtotal: '1500.00',
  taxRatePercent: '16.00',
  taxAmount: '240.00',
  total: '1740.00',
  notes: 'يرجى التحويل إلى الحساب المذكور',
  office: {
    name: 'مكتب العدل للمحاماة',
    address: 'رام الله، شارع الإرسال',
    phone: '+970 2 295 1234',
    email: 'office@example.test',
    taxId: '562345678',
    registrationNumber: null,
  },
  client: { name: 'سامر خليل', address: null, phone: '0599123456', email: null },
  file: { fileNumber: '2026-LIT-00012', title: 'دعوى مطالبة مالية' },
  lines: [
    { description: 'إعداد لائحة الدعوى', quantity: '3.5', unitPrice: '300.00', amount: '1050.00' },
    { description: 'رسوم المحكمة', quantity: '1', unitPrice: '450.00', amount: '450.00' },
  ],
};

async function text(pdf: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  const { text: pages } = await extractText(doc, { mergePages: true });
  return pages;
}

describe('invoice PDF (MVP-92)', () => {
  itPrints(
    'should print an Arabic invoice whose text holds the client name and the total',
    async () => {
      const pdf = await printPdf(
        chromium ?? 'chromium',
        invoiceHtml(SAMPLE),
        AbortSignal.timeout(60_000),
      );
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      const content = (await text(pdf)).normalize('NFKC');
      expect(content).toContain('INV-2026-0007');
      expect(content).toMatch(/1,740\.00/);
      // pdf.js reads right-to-left runs in visual order; either order proves the name is in the text layer.
      const flat = content.replace(/\s+/g, '');
      expect([flat, [...flat].reverse().join('')].some((t) => t.includes('سامرخليل'))).toBe(true);
    },
    90_000,
  );

  itPrints(
    'should print an English invoice',
    async () => {
      const pdf = await printPdf(
        chromium ?? 'chromium',
        invoiceHtml({
          ...SAMPLE,
          language: 'EN',
          client: { ...SAMPLE.client, name: 'Acme Trading' },
        }),
        AbortSignal.timeout(60_000),
      );
      const content = await text(pdf);
      expect(content).toContain('Total due');
      expect(content).toContain('Acme Trading');
      expect(content).toMatch(/1,740\.00/);
    },
    90_000,
  );
});
