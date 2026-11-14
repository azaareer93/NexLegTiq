import { extractText, getDocumentProxy } from 'unpdf';

import { receiptHtml } from './receipt-pdf.html';
import type { ReceiptPdfData } from './receipt-pdf.html';
import { printPdf } from '../invoices/pdf/chromium';
import { canPrint, TEST_CHROMIUM as chromium } from '../invoices/pdf/chromium.test-helper';

const itPrints = canPrint ? it : it.skip;

const SAMPLE: ReceiptPdfData = {
  language: 'EN',
  receiptNumber: 'RCT-2026-0042',
  paidAt: '2026-11-14',
  amount: '150.50',
  currency: 'ILS',
  method: 'BANK_TRANSFER',
  reference: 'TRX-778899',
  voided: false,
  issuer: { name: 'NexLegTiq Ltd', address: 'Ramallah', taxId: '562000111' },
  office: { name: 'Al-Adl Law Office', address: null, email: 'office@example.test' },
};

describe('payment receipt PDF (MVP-170)', () => {
  itPrints(
    'should print a receipt whose text holds the number, amount and office name',
    async () => {
      const pdf = await printPdf(
        chromium ?? 'chromium',
        receiptHtml(SAMPLE),
        AbortSignal.timeout(60_000),
      );
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      const doc = await getDocumentProxy(new Uint8Array(pdf));
      const { text } = await extractText(doc, { mergePages: true });
      const content = text.normalize('NFKC');
      expect(content).toContain('RCT-2026-0042');
      expect(content).toMatch(/150\.50/);
      expect(content).toContain('Al-Adl Law Office');
      expect(content).toContain('not a tax invoice');
    },
  );
});
