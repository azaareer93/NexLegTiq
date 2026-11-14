import { receiptHtml } from './receipt-pdf.html';
import type { ReceiptPdfData } from './receipt-pdf.html';

const data: ReceiptPdfData = {
  language: 'AR',
  receiptNumber: 'RCT-2026-0001',
  paidAt: '2026-11-14',
  amount: '1200.500',
  currency: 'JOD',
  method: 'CASH',
  reference: null,
  voided: false,
  issuer: { name: 'NexLegTiq', address: null, taxId: null },
  office: { name: 'مكتب <b>العدل</b>', address: 'رام الله', email: null },
};

describe('receiptHtml', () => {
  it('should write an Arabic receipt right to left, the number isolated, with no tax line', () => {
    const html = receiptHtml(data);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('<bdi dir="ltr">RCT-2026-0001</bdi>');
    expect(html).toContain('نقدًا');
    expect(html).toContain('ليس فاتورة ضريبية');
    expect(html).not.toMatch(/ضريبة|VAT/);
    // An unset issuer address / number and reference leave no empty line.
    expect(html).not.toContain('رقم التسجيل');
    expect(html).not.toContain('المرجع');
  });

  it('should escape every value and stamp a voided receipt', () => {
    const html = receiptHtml({
      ...data,
      language: 'EN',
      voided: true,
      reference: '"><script>x</script>',
      issuer: { name: 'NexLegTiq', address: 'Ramallah', taxId: '562000111' },
    });
    expect(html).toContain('dir="ltr"');
    expect(html).not.toContain('<script>x');
    expect(html).not.toContain('<b>العدل</b>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('class="stamp">Void<');
    expect(html).toContain('Registration / tax no.');
  });
});
