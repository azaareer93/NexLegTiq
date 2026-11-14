import { InvoicePdfService } from './invoice-pdf.service';

const ID = '01900000-0000-7000-8000-000000000001';
const UPDATED = new Date('2026-11-14T08:00:00Z');

function setup(row: object | null, defaultLanguage = 'BILINGUAL') {
  const prisma = {
    db: {
      invoice: { findFirst: jest.fn().mockResolvedValue(row) },
      office: { findFirstOrThrow: jest.fn().mockResolvedValue({ defaultLanguage }) },
    },
  };
  const access = { visibleWhere: () => ({ id: { not: '' } }) };
  const storage = { presignedGetUrl: jest.fn().mockResolvedValue('https://s3.test/x') };
  const queues = { enqueue: jest.fn() };
  const audit = { log: jest.fn() };
  const service = new InvoicePdfService(
    prisma as never,
    access as never,
    storage as never,
    queues as never,
    audit as never,
  );
  return { service, storage, queues, audit };
}
const stored = (over: object = {}) => ({
  id: ID,
  invoiceNumber: 'INV-2026-0007',
  updatedAt: UPDATED,
  pdfStorageKey: 'o1/invoices/x.pdf',
  pdfLanguage: 'AR',
  pdfRenderedFor: UPDATED,
  ...over,
});

describe('InvoicePdfService (MVP-92)', () => {
  it('should link a current PDF named after the invoice and audit the download', async () => {
    const { service, storage, audit, queues } = setup(stored());
    await expect(service.link(ID)).resolves.toEqual({
      status: 'READY',
      downloadUrl: 'https://s3.test/x',
      expiresIn: 300,
    });
    expect(storage.presignedGetUrl).toHaveBeenCalledWith('o1/invoices/x.pdf', {
      expiresIn: 300,
      filename: 'INV-2026-0007.pdf',
      contentType: 'application/pdf',
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'DOWNLOAD' }),
    );
    expect(queues.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ['another language', stored(), 'EN'],
    ['a stale PDF', stored({ pdfRenderedFor: new Date(0) }), 'AR'],
    ['no PDF', stored({ pdfStorageKey: null, invoiceNumber: null }), undefined],
  ])('should queue a render for %s', async (_case, row, language) => {
    const { service, queues } = setup(row, 'EN');
    await expect(service.link(ID, language as never)).resolves.toEqual({ status: 'RENDERING' });
    expect(queues.enqueue).toHaveBeenCalledWith(
      'report',
      'render-invoice-pdf',
      { invoiceId: ID, language: language ?? 'EN', email: false },
      { jobId: expect.stringContaining(`invoice-pdf-${ID}-`) as string },
    );
  });

  it('should answer 404 for an invoice the caller cannot see', async () => {
    await expect(setup(null).service.link(ID)).rejects.toMatchObject({ code: 'RES-001' });
  });
});
