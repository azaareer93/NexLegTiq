import { InvoicePdfService } from './invoice-pdf.service';

const ID = '01900000-0000-7000-8000-000000000001';
const UPDATED = new Date('2026-11-14T08:00:00Z');

function setup(row: object | null, defaultLanguage = 'BILINGUAL') {
  const prisma = {
    db: {
      invoice: {
        findFirst: jest.fn().mockResolvedValue(row),
      },
      auditLog: { create: jest.fn() },
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
  return { service, storage, queues, audit, prisma };
}
const stored = (over: object = {}) => ({
  id: ID,
  officeId: 'o1',
  invoiceNumber: 'INV-2026-0007',
  updatedAt: UPDATED,
  pdfStorageKey: 'o1/invoices/x.pdf',
  pdfLanguage: 'AR',
  pdfRenderedFor: UPDATED,
  ...over,
});

describe('InvoicePdfService (MVP-92)', () => {
  it('should give the portal the same PDF, audited as the portal account without an office user (D-188)', async () => {
    const { service, prisma, audit } = setup(stored());
    const client = { ip: '1.2.3.4', userAgent: 'ua', requestId: 'r1' };
    await expect(service.portalLink({ id: ID }, 'cu1', client)).resolves.toMatchObject({
      status: 'READY',
    });
    expect(prisma.db.invoice.findFirst.mock.calls[0][0].where).toEqual({ id: ID });
    expect(prisma.db.auditLog.create.mock.calls[0][0].data).toMatchObject({
      officeId: 'o1',
      userId: null,
      clientUserId: 'cu1',
      action: 'DOWNLOAD',
      newValues: { language: 'AR', portal: true },
    });
    expect(audit.log).not.toHaveBeenCalled();
    await expect(setup(null).service.portalLink({ id: ID }, 'cu1', client)).resolves.toBeNull();
    const rendering = setup(stored({ pdfRenderedFor: null }));
    await expect(rendering.service.portalLink({ id: ID }, 'cu1', client)).resolves.toEqual({
      status: 'RENDERING',
    });
    expect(rendering.prisma.db.auditLog.create).not.toHaveBeenCalled();
    const unnumbered = setup(stored({ invoiceNumber: null }));
    await unnumbered.service.portalLink({ id: ID }, 'cu1', client);
    expect(unnumbered.storage.presignedGetUrl.mock.calls[0][1]).toMatchObject({
      filename: 'invoice-draft.pdf',
    });
    // Only "not found" becomes null; any other failure still surfaces.
    const broken = setup(stored());
    broken.storage.presignedGetUrl.mockRejectedValueOnce(new Error('s3 down'));
    await expect(broken.service.portalLink({ id: ID }, 'cu1', client)).rejects.toThrow('s3 down');
  });

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
