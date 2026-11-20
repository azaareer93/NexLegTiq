import { Injectable } from '@nestjs/common';
import type {
  PortalInvoice,
  PortalInvoicePdf,
  PortalOfficeAccess,
} from '@nexlegtiq/shared-contracts';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { roundMoney } from '@nexlegtiq/shared-utils';

import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import { portalInvoiceWhere } from '../invoices/invoice-sharing.service';
import { InvoicePdfService } from '../invoices/pdf/invoice-pdf.service';
import { PortalAccounts } from '../portal-auth/portal-accounts';

/** shortcut: the newest 200 shared invoices per office, unpaged; page when a client passes this. */
const MAX_INVOICES = 200;

const invoiceSelect = {
  id: true,
  invoiceNumber: true,
  status: true,
  currency: true,
  issueDate: true,
  dueDate: true,
  total: true,
  paidAt: true,
  // The billed file, shown only while it is live and still the client's (the bill-to client is the boundary, D-188).
  file: {
    select: {
      id: true,
      fileNumber: true,
      title: true,
      deletedAt: true,
      clients: { select: { clientId: true } },
    },
  },
} satisfies Prisma.InvoiceSelect;
type InvoiceRow = Prisma.InvoiceGetPayload<{ select: typeof invoiceSelect }>;

/** The billed file, only while it is live and still linked to the grant's client. */
const shownFile = (grant: PortalOfficeAccess, file: InvoiceRow['file']) =>
  file && !file.deletedAt && file.clients.some((link) => link.clientId === grant.clientId)
    ? { id: file.id, fileNumber: file.fileNumber, title: file.title }
    : null;

/** The portal shape; null for a row that is not an issued invoice (the filter admits none — D-162 gives every issued one its number and dates). */
const toPortalInvoice = (grant: PortalOfficeAccess, row: InvoiceRow): PortalInvoice | null => {
  const { invoiceNumber, issueDate, dueDate, status, file } = row;
  if (!invoiceNumber || !issueDate || !dueDate || status === 'DRAFT' || status === 'VOID')
    return null;
  return {
    id: row.id,
    officeId: grant.officeId,
    officeName: grant.officeName,
    invoiceNumber,
    status,
    currency: row.currency,
    issueDate: issueDate.toISOString().slice(0, 10),
    dueDate: dueDate.toISOString().slice(0, 10),
    total: roundMoney(row.total.toFixed(), row.currency),
    paidAt: row.paidAt?.toISOString() ?? null,
    file: shownFile(grant, file),
  };
};

/**
 * A client's invoices on the portal (MVP-150, D-188): in every office the account may enter, those the office shared with
 * the grant's client once issued, newest first; the PDF is the office's own render (D-171). Anything else is 404.
 */
@Injectable()
export class PortalInvoicesService {
  constructor(
    private readonly accounts: PortalAccounts,
    private readonly tenants: TenantRunner,
    private readonly prisma: PrismaService,
    private readonly pdfs: InvoicePdfService,
  ) {}

  async list(clientUserId: string): Promise<PortalInvoice[]> {
    const grants = await this.accounts.offices(clientUserId);
    const lists = await Promise.all(
      grants.map(async (grant) => {
        const rows = await this.inOffice(grant, () =>
          this.prisma.db.invoice.findMany({
            where: portalInvoiceWhere(grant.clientId),
            orderBy: [{ issueDate: 'desc' }, { id: 'desc' }],
            take: MAX_INVOICES,
            select: invoiceSelect,
          }),
        );
        return rows.map((row) => toPortalInvoice(grant, row));
      }),
    );
    return lists
      .flat()
      .filter((invoice): invoice is PortalInvoice => invoice !== null)
      .sort((a, b) => b.issueDate.localeCompare(a.issueDate) || b.id.localeCompare(a.id));
  }

  /** The PDF of a shared invoice, looked up with the same scope as the list (one query, no gap), audited as the account. */
  async pdf(
    clientUserId: string,
    invoiceId: string,
    client: ClientInfo,
  ): Promise<PortalInvoicePdf> {
    for (const grant of await this.accounts.offices(clientUserId)) {
      const answer = await this.inOffice(grant, () =>
        this.pdfs.portalLink(invoiceId, grant.clientId, clientUserId, client),
      );
      if (answer) return answer;
    }
    throw new ResourceNotFoundException();
  }

  private inOffice<T>(grant: PortalOfficeAccess, work: () => Promise<T>): Promise<T> {
    return this.tenants.run({ officeId: grant.officeId as OfficeId }, work);
  }
}
