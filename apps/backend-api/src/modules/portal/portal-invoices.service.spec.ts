import { PortalInvoicesService } from './portal-invoices.service';
import type { TenantRunner } from '../../common/tenancy/tenant-runner';
import type { PrismaService } from '../../database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import type { InvoicePdfService } from '../invoices/pdf/invoice-pdf.service';
import type { PortalAccounts } from '../portal-auth/portal-accounts';

const NO_CLIENT = { ip: '127.0.0.1', userAgent: null, requestId: null };
const A = { officeId: 'o-a', officeName: 'Office A', clientId: 'c-a', clientName: 'Client' };
const B = { officeId: 'o-b', officeName: 'Office B', clientId: 'c-b', clientName: 'Client' };
const paidAt = new Date('2026-11-20T10:00:00Z');

const row = (id: string, issueDate: string, over: object = {}) => ({
  id,
  invoiceNumber: `INV-${id}`,
  status: 'SENT',
  currency: 'ILS',
  issueDate: new Date(`${issueDate}T00:00:00Z`),
  dueDate: new Date('2026-12-31T00:00:00Z'),
  total: new Prisma.Decimal('116'),
  paidAt: null,
  file: null,
  ...over,
});

function setup(grants = [A, B]) {
  const office: string[] = [];
  const db = { invoice: { findMany: jest.fn().mockResolvedValue([]) } };
  const pdfs = { portalLink: jest.fn().mockResolvedValue(null) };
  const service = new PortalInvoicesService(
    { offices: jest.fn().mockResolvedValue(grants) } as unknown as PortalAccounts,
    {
      run: jest.fn((ctx: { officeId: string }, work: () => Promise<unknown>) => {
        office.push(ctx.officeId);
        return work();
      }),
    } as unknown as TenantRunner,
    { db } as unknown as PrismaService,
    pdfs as unknown as InvoicePdfService,
  );
  return { service, db, pdfs, office };
}

describe('PortalInvoicesService (D-188)', () => {
  it("should list every office's shared, issued invoices of the grant's client, newest first across offices", async () => {
    const { service, db } = setup();
    db.invoice.findMany.mockResolvedValueOnce([row('a1', '2026-10-01')]).mockResolvedValueOnce([
      row('b1', '2026-11-01', {
        status: 'PAID',
        currency: 'JOD',
        total: new Prisma.Decimal('116.0006'),
        paidAt,
      }),
      row('b0', '2026-09-01', { status: 'DRAFT', invoiceNumber: null }),
    ]);
    const invoices = await service.list('u1');
    expect(invoices.map((i) => [i.id, i.officeName])).toEqual([
      ['b1', 'Office B'],
      ['a1', 'Office A'],
    ]);
    expect(invoices[0]).toMatchObject({
      total: '116.001',
      paidAt: paidAt.toISOString(),
      issueDate: '2026-11-01',
    });
    expect(db.invoice.findMany.mock.calls[1][0]).toMatchObject({
      where: {
        clientId: 'c-b',
        sharedWithClient: true,
        status: { in: ['SENT', 'OVERDUE', 'PAID'] },
      },
      orderBy: [{ issueDate: 'desc' }, { id: 'desc' }],
      take: 200,
    });
  });

  it('should break a same-day tie by id, highest first, across offices', async () => {
    const { service, db } = setup();
    db.invoice.findMany
      .mockResolvedValueOnce([row('a1', '2026-11-01')])
      .mockResolvedValueOnce([row('b9', '2026-11-01')]);
    expect((await service.list('u1')).map((i) => i.id)).toEqual(['b9', 'a1']);
  });

  it('should hand out the PDF from the office whose scoped lookup finds the invoice, else 404', async () => {
    const { service, pdfs, office } = setup();
    pdfs.portalLink.mockResolvedValueOnce(null).mockResolvedValueOnce({ status: 'RENDERING' });
    await expect(service.pdf('u1', 'i1', NO_CLIENT)).resolves.toEqual({ status: 'RENDERING' });
    expect(office).toEqual(['o-a', 'o-b']);
    expect(pdfs.portalLink).toHaveBeenLastCalledWith(
      {
        id: 'i1',
        clientId: 'c-b',
        sharedWithClient: true,
        status: { in: ['SENT', 'OVERDUE', 'PAID'] },
      },
      'u1',
      NO_CLIENT,
    );
    pdfs.portalLink.mockResolvedValue(null);
    await expect(service.pdf('u1', 'i1', NO_CLIENT)).rejects.toMatchObject({ code: 'RES-001' });
  });
});
