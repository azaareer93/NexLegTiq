import { Readable } from 'node:stream';

import { ReceiptJobSchema, ReceiptPdfRenderer } from './receipt-pdf.renderer';
import { printPdf } from '../invoices/pdf/chromium';

jest.mock('../invoices/pdf/chromium', () => ({ printPdf: jest.fn() }));
const print = printPdf as jest.MockedFunction<typeof printPdf>;

const ID = '01920000-0000-7000-8000-0000000000c1';
const UPDATED = new Date('2026-11-14T10:00:00.000Z');
const PDF = Buffer.from('%PDF-new');

function payment(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    receiptNumber: 'RCT-2026-0007',
    paidAt: new Date('2026-11-14T00:00:00Z'),
    amount: { toFixed: () => '10.125' },
    currency: 'JOD',
    method: 'CASH',
    reference: null,
    voidedAt: null,
    payerName: 'Office as recorded',
    payerAddress: null,
    payerEmail: null,
    updatedAt: UPDATED,
    pdfStorageKey: null as string | null,
    pdfLanguage: null as string | null,
    pdfRenderedFor: null as Date | null,
    ...over,
  };
}

function build(
  row: ReturnType<typeof payment> | null,
  office = { name: 'Office now', email: 'o@example.test' },
  swapped = 1,
) {
  const updateMany = jest.fn().mockResolvedValue({ count: swapped });
  const prisma = {
    db: {
      platformPayment: { findFirst: jest.fn().mockResolvedValue(row), updateMany },
      office: { findFirstOrThrow: jest.fn().mockResolvedValue(office) },
    },
  };
  const storage = {
    keyFor: jest.fn((...parts: string[]) => `o1/${parts.join('/')}`),
    put: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    getStream: jest.fn().mockResolvedValue(Readable.from([Buffer.from('%PDF-old')])),
  };
  const mail = { send: jest.fn().mockResolvedValue(undefined) };
  const config = {
    chromiumPath: 'chromium',
    receiptIssuer: { name: 'NexLegTiq', address: null, taxId: null },
    mail: { officeAppUrl: 'https://app.example.test' },
  };
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() };
  const renderer = new ReceiptPdfRenderer(
    prisma as never,
    storage as never,
    mail as never,
    config as never,
    logger as never,
  );
  return { renderer, updateMany, storage, mail };
}

const signal = new AbortController().signal;

describe('ReceiptPdfRenderer', () => {
  beforeEach(() => print.mockReset().mockResolvedValue(PDF));

  it('should skip a payment it cannot see (another office) without printing or storing', async () => {
    const { renderer, storage, mail } = build(null);
    await expect(
      renderer.run({ paymentId: ID, language: 'AR', email: true }, 'j1', signal),
    ).resolves.toEqual({ skipped: 'NOT_FOUND' });
    expect(print).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('should print the payer as recorded, store it without touching updatedAt and email the office once', async () => {
    const { renderer, updateMany, storage, mail } = build(payment());
    await expect(
      renderer.run({ paymentId: ID, language: 'EN', email: true }, 'j1', signal),
    ).resolves.toEqual({ rendered: true, emailed: true });
    const html = print.mock.calls[0]?.[1] ?? '';
    expect(html).toContain('Office as recorded');
    expect(html).not.toContain('Office now');
    expect(html).toContain('10.125');
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: ID, updatedAt: UPDATED, pdfStorageKey: null },
      data: expect.objectContaining({
        pdfLanguage: 'EN',
        pdfRenderedFor: UPDATED,
        updatedAt: UPDATED,
      }),
    });
    expect(storage.delete).not.toHaveBeenCalled();
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send).toHaveBeenCalledWith(
      'o@example.test',
      expect.objectContaining({ subject: expect.stringContaining('RCT-2026-0007') }),
      expect.objectContaining({
        idempotencyKey: 'receipt-email-j1',
        attachments: [expect.objectContaining({ filename: 'RCT-2026-0007.pdf', content: PDF })],
      }),
    );
  });

  it('should reuse a current receipt and attach the stored file', async () => {
    const { renderer, mail } = build(
      payment({ pdfStorageKey: 'o1/receipts/x.pdf', pdfLanguage: 'AR', pdfRenderedFor: UPDATED }),
    );
    await expect(
      renderer.run({ paymentId: ID, language: 'AR', email: true }, 'j2', signal),
    ).resolves.toEqual({ rendered: false, emailed: true });
    expect(print).not.toHaveBeenCalled();
    const options = mail.send.mock.calls[0]?.[2] as { attachments: { content: Buffer }[] };
    expect(options.attachments[0]?.content.toString()).toBe('%PDF-old');
  });

  it('should re-print a receipt rendered in another language and drop the old file', async () => {
    const { renderer, storage } = build(
      payment({ pdfStorageKey: 'o1/receipts/x.pdf', pdfLanguage: 'AR', pdfRenderedFor: UPDATED }),
    );
    await expect(
      renderer.run({ paymentId: ID, language: 'EN', email: false }, 'j3', signal),
    ).resolves.toEqual({ rendered: true });
    expect(storage.delete).toHaveBeenCalledWith('o1/receipts/x.pdf');
  });

  it('should not email a voided payment or an office without an address', async () => {
    for (const [row, office] of [
      [payment({ voidedAt: new Date() }), { name: 'n', email: 'o@example.test' }],
      [payment(), { name: 'n', email: null }],
    ] as const) {
      const { renderer, mail } = build(row, office as never);
      await expect(
        renderer.run({ paymentId: ID, language: 'AR', email: true }, 'j4', signal),
      ).resolves.toEqual({ rendered: true, emailed: false });
      expect(mail.send).not.toHaveBeenCalled();
    }
  });

  it('should delete its own upload and fail the attempt when the payment changed during the print', async () => {
    const { renderer, storage, mail } = build(payment(), undefined, 0);
    await expect(
      renderer.run({ paymentId: ID, language: 'AR', email: true }, 'j5', signal),
    ).rejects.toThrow('Payment changed');
    expect(storage.delete).toHaveBeenCalledWith(expect.stringMatching(/^o1\/receipts\//));
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('should validate the job payload, emailing only when asked', () => {
    expect(ReceiptJobSchema.parse({ paymentId: ID, language: 'EN' }).email).toBe(false);
    expect(ReceiptJobSchema.safeParse({ paymentId: 'x', language: 'EN' }).success).toBe(false);
    expect(ReceiptJobSchema.safeParse({ paymentId: ID, language: 'FR' }).success).toBe(false);
  });

  it('should keep going when the old file cannot be deleted', async () => {
    const { renderer, storage } = build(
      payment({ pdfStorageKey: 'o1/receipts/old.pdf', pdfLanguage: 'AR', pdfRenderedFor: UPDATED }),
    );
    storage.delete.mockRejectedValue(new Error('storage down'));
    await expect(
      renderer.run({ paymentId: ID, language: 'EN', email: false }, 'j6', signal),
    ).resolves.toEqual({ rendered: true });
  });
});
