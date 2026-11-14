import { printPdf } from './chromium';
import { esc, invoiceHtml } from './invoice-pdf.html';
import { InvoicePdfRenderer, recipientOf } from './invoice-pdf.renderer';
import { Prisma } from '../../../generated/prisma/client';

jest.mock('./chromium', () => ({ printPdf: jest.fn(async () => Buffer.from('%PDF-1.7 test')) }));

const ID = '01900000-0000-7000-8000-000000000001';
const UPDATED = new Date('2026-11-14T08:00:00Z');
const d = (value: string) => new Prisma.Decimal(value);

const row = (over: object = {}) => ({
  id: ID,
  invoiceNumber: 'INV-2026-0007',
  status: 'SENT',
  currency: 'ILS',
  issueDate: new Date('2026-11-14T00:00:00Z'),
  dueDate: new Date('2026-12-14T00:00:00Z'),
  subtotal: d('100'),
  taxRatePercent: d('16'),
  taxAmount: d('16'),
  total: d('116'),
  notes: null,
  updatedAt: UPDATED,
  pdfStorageKey: null,
  pdfLanguage: null,
  pdfRenderedFor: null,
  client: {
    displayName: '<b>Acme</b>',
    deletedAt: null,
    isActive: true,
    address: null,
    phone: null,
    email: 'client@example.test',
    contacts: [{ email: 'billing@example.test' }],
  },
  file: null,
  lines: [{ description: 'Work', quantity: d('1'), unitPrice: d('100'), amount: d('100') }],
  ...over,
});

function setup(invoice: object | null = row(), updated = 1) {
  const prisma = {
    db: {
      invoice: {
        findFirst: jest.fn().mockResolvedValue(invoice),
        updateMany: jest.fn().mockResolvedValue({ count: updated }),
      },
      office: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          name: 'Office',
          address: null,
          phone: null,
          email: null,
          taxId: null,
          registrationNumber: null,
        }),
      },
    },
  };
  const storage = {
    keyFor: jest.fn((...parts: string[]) => ['o1', ...parts].join('/')),
    put: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
    getStream: jest.fn(),
  };
  const mail = { send: jest.fn() };
  const config = { chromiumPath: 'chromium', mail: { officeAppUrl: 'https://app.example.test' } };
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
  const renderer = new InvoicePdfRenderer(
    prisma as never,
    storage as never,
    mail as never,
    config as never,
    logger as never,
  );
  return { renderer, prisma, storage, mail };
}
const signal = new AbortController().signal;

describe('InvoicePdfRenderer (MVP-92)', () => {
  it('should store the PDF without changing updatedAt and email it to the primary contact', async () => {
    const { renderer, prisma, storage, mail } = setup();
    const result = await renderer.run(
      { invoiceId: ID, language: 'EN', email: true },
      'job-1',
      signal,
    );
    expect(result).toEqual({ rendered: true, emailed: true });
    expect(prisma.db.invoice.updateMany).toHaveBeenCalledWith({
      where: { id: ID, updatedAt: UPDATED, pdfStorageKey: null },
      data: expect.objectContaining({
        pdfLanguage: 'EN',
        pdfRenderedFor: UPDATED,
        updatedAt: UPDATED,
      }),
    });
    expect(storage.put).toHaveBeenCalledWith(
      expect.stringMatching(/^o1\/invoices\//),
      expect.any(Buffer),
      {
        contentType: 'application/pdf',
        contentLength: 13,
      },
    );
    expect(mail.send).toHaveBeenCalledWith(
      'billing@example.test',
      expect.objectContaining({ subject: expect.stringContaining('INV-2026-0007') }),
      expect.objectContaining({
        idempotencyKey: 'invoice-email-job-1',
        attachments: [expect.objectContaining({ filename: 'INV-2026-0007.pdf' })],
      }),
    );
  });

  it('should fail the attempt and drop its object when the invoice changed during the print', async () => {
    const { renderer, storage, mail } = setup(row(), 0);
    await expect(
      renderer.run({ invoiceId: ID, language: 'AR', email: true }, 'job-2', signal),
    ).rejects.toThrow('Invoice changed');
    expect(storage.delete).toHaveBeenCalledWith(expect.stringMatching(/^o1\/invoices\//));
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('should reuse a current PDF and skip a missing invoice', async () => {
    (printPdf as jest.Mock).mockClear();
    const current = row({
      pdfStorageKey: 'o1/invoices/x.pdf',
      pdfLanguage: 'AR',
      pdfRenderedFor: UPDATED,
    });
    const { renderer } = setup(current);
    expect(
      await renderer.run({ invoiceId: ID, language: 'AR', email: false }, 'j', signal),
    ).toEqual({
      rendered: false,
    });
    expect(printPdf).not.toHaveBeenCalled();
    expect(
      await setup(null).renderer.run({ invoiceId: ID, language: 'AR', email: false }, 'j', signal),
    ).toEqual({
      skipped: 'NOT_FOUND',
    });
  });

  it('should not email without a recipient or a number, and read a stored PDF to attach', async () => {
    const noOne = setup(row({ client: { ...row().client, email: null, contacts: [] } }));
    expect(
      await noOne.renderer.run({ invoiceId: ID, language: 'AR', email: true }, 'j', signal),
    ).toEqual({ rendered: true, emailed: false });
    expect(noOne.mail.send).not.toHaveBeenCalled();
    const stored = setup(
      row({
        pdfStorageKey: 'o1/invoices/x.pdf',
        pdfLanguage: 'AR',
        pdfRenderedFor: UPDATED,
        dueDate: null,
      }),
    );
    stored.storage.getStream.mockResolvedValue([Buffer.from('%PDF')]);
    expect(
      await stored.renderer.run({ invoiceId: ID, language: 'AR', email: true }, 'j', signal),
    ).toEqual({ rendered: false, emailed: true });
    expect(stored.storage.getStream).toHaveBeenCalledWith('o1/invoices/x.pdf');
    expect(stored.mail.send.mock.calls[0]?.[1].text).not.toContain('تاريخ الاستحقاق');
  });

  it.each([
    ['a voided invoice', { status: 'VOID' }],
    ['a paid invoice', { status: 'PAID' }],
    ['a deleted client', { client: { ...row().client, deletedAt: new Date() } }],
    ['an inactive client', { client: { ...row().client, isActive: false } }],
  ])('should not email %s', async (_case, over) => {
    const { renderer, mail } = setup(row(over));
    const result = await renderer.run({ invoiceId: ID, language: 'AR', email: true }, 'j', signal);
    expect(result).toEqual({ rendered: true, emailed: false });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("should fall back to the client's own address", () => {
    expect(recipientOf({ ...row().client, contacts: [] } as never)).toBe('client@example.test');
  });
});

describe('invoiceHtml (MVP-92)', () => {
  const data = {
    language: 'AR' as const,
    status: 'DRAFT',
    invoiceNumber: null,
    issueDate: null,
    dueDate: null,
    currency: 'ILS',
    subtotal: '100.00',
    taxRatePercent: '0.00',
    taxAmount: '0.00',
    total: '100.00',
    notes: '<script>alert(1)</script>',
    office: {
      name: 'A & B',
      address: null,
      phone: null,
      email: null,
      taxId: null,
      registrationNumber: null,
    },
    client: { name: '"Acme"', address: null, phone: null, email: null },
    file: null,
    lines: [],
  };

  it('should escape every value and lay a draft out right to left without a tax row', () => {
    const html = invoiceHtml(data);
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('مسودة');
    expect(html).toContain('A &amp; B');
    expect(html).toContain('&quot;Acme&quot;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('الضريبة (');
    expect(esc(`<'&">`)).toBe('&lt;&#39;&amp;&quot;&gt;');
  });

  it('should show every detail that is set, isolated, with the tax row and notes', () => {
    const html = invoiceHtml({
      ...data,
      invoiceNumber: 'INV-2026-0001',
      issueDate: '2026-11-14',
      dueDate: '2026-12-14',
      taxRatePercent: '16.00',
      taxAmount: '16.00',
      notes: 'Bank transfer',
      office: {
        name: 'Office',
        address: 'Ramallah',
        phone: '+970 2 295 1234',
        email: 'o@example.test',
        taxId: '562345678',
        registrationNumber: 'R-1',
      },
      client: { name: 'Client', address: 'Nablus', phone: '0599', email: 'c@example.test' },
      file: { fileNumber: '2026-LIT-00001', title: 'Claim' },
      lines: [{ description: 'Work', quantity: '1.5', unitPrice: '100.00', amount: '150.00' }],
    });
    for (const text of [
      'Ramallah',
      'Nablus',
      'R-1',
      'Bank transfer',
      'Claim',
      '14/12/2026',
      'الضريبة (',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('<bdi dir="ltr">2026-LIT-00001</bdi>');
    expect(html).toContain('<bdi dir="ltr">+970 2 295 1234</bdi>');
  });

  it('should stamp paid and void invoices, and nothing else', () => {
    expect(invoiceHtml({ ...data, status: 'VOID' })).toContain('class="stamp void">ملغاة');
    expect(invoiceHtml({ ...data, status: 'PAID', language: 'EN' })).toContain(
      'class="stamp paid">Paid',
    );
    expect(invoiceHtml({ ...data, status: 'SENT' })).not.toContain('class="stamp');
  });

  it('should write English left to right', () => {
    expect(invoiceHtml({ ...data, language: 'EN' })).toContain('<html lang="en" dir="ltr">');
  });
});
