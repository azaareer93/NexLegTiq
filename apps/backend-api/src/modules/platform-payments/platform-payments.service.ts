import { Injectable } from '@nestjs/common';
import type {
  AdminPayment,
  PaymentReceipt,
  RecordPaymentRequest,
} from '@nexlegtiq/shared-contracts';
import type { OfficeId } from '@nexlegtiq/shared-types';
import { currencyDigits, roundMoney, wallClock } from '@nexlegtiq/shared-utils';
import { ClsService } from 'nestjs-cls';

import { RENDER_PAYMENT_RECEIPT_JOB, receiptIsCurrent } from './receipt-pdf.renderer';
import type { ReceiptJob } from './receipt-pdf.renderer';
import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  ResourceNotFoundException,
  ValidationException,
} from '../../common/errors/app.exception';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { StorageService } from '../../common/storage/storage.service';
import { TenantRunner } from '../../common/tenancy/tenant-runner';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import type { ClientInfo } from '../auth/client-info';
import type { PdfLanguage } from '../invoices/pdf/invoice-pdf.html';
import { pdfLanguageOf } from '../invoices/pdf/invoice-pdf.service';
import { PlatformAuditService } from '../platform-auth/platform-audit.service';

const LINK_TTL_SECONDS = 300;
/** Receipts are numbered by the issuing company's year; it sells in Palestine first (D-174). */
const RECEIPT_TIME_ZONE = 'Asia/Hebron';

const SELECT = {
  id: true,
  officeId: true,
  receiptNumber: true,
  amount: true,
  currency: true,
  method: true,
  reference: true,
  paidAt: true,
  voidedAt: true,
  voidReason: true,
  createdAt: true,
  recordedBy: { select: { id: true, fullName: true } },
} as const satisfies Prisma.PlatformPaymentSelect;
type Row = Prisma.PlatformPaymentGetPayload<{ select: typeof SELECT }>;

export const receiptNumber = (year: number, seq: number) =>
  `RCT-${year}-${String(seq).padStart(4, '0')}`;

function present(row: Row): AdminPayment {
  return {
    id: row.id,
    officeId: row.officeId,
    receiptNumber: row.receiptNumber,
    amount: roundMoney(row.amount.toFixed(), row.currency),
    currency: row.currency,
    method: row.method,
    reference: row.reference,
    paidAt: row.paidAt.toISOString().slice(0, 10),
    recordedBy: row.recordedBy,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
    createdAt: row.createdAt.toISOString(),
  };
}

const decimals = (amount: string) => amount.split('.')[1]?.length ?? 0;

/**
 * Manual payments to the platform (MVP-170, D-174): recorded by a platform admin with a gap-free receipt number
 * `RCT-{YEAR}-{SEQ:4}` (owner 2A), never deleted (voided instead), and never changing the subscription (owner 3A).
 * The receipt PDF is printed and emailed by the worker in the paying office's context, so its key is `{officeId}/…`.
 */
@Injectable()
export class PlatformPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: PlatformAuditService,
    private readonly queues: QueueProducer,
    private readonly tenant: TenantRunner,
    private readonly storage: StorageService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  async list(officeId: string): Promise<AdminPayment[]> {
    // unscoped: platform admin code reads any office's payments (D-080).
    const raw = this.prisma.unscoped();
    const office = await raw.office.findUnique({ where: { id: officeId }, select: { id: true } });
    if (!office) throw new ResourceNotFoundException();
    const rows = await raw.platformPayment.findMany({
      where: { officeId },
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      select: SELECT,
    });
    return rows.map(present);
  }

  async record(
    officeId: string,
    body: RecordPaymentRequest,
    adminId: string,
    client: ClientInfo,
  ): Promise<AdminPayment> {
    if (decimals(body.amount) > currencyDigits(body.currency)) {
      throw new ValidationException([{ field: 'amount', message: 'validation.amount' }]);
    }
    // unscoped: the platform realm has no office context (D-080).
    const raw = this.prisma.unscoped();
    const office = await raw.office.findUnique({
      where: { id: officeId },
      select: { timezone: true, email: true, defaultLanguage: true },
    });
    if (!office) throw new ResourceNotFoundException();
    if (body.paidAt > wallClock(new Date(), office.timezone).date) {
      throw new ValidationException([{ field: 'paidAt', message: 'validation.futureDate' }]);
    }
    if (body.emailOffice && !office.email) {
      throw new ValidationException([
        { field: 'emailOffice', message: 'validation.noOfficeEmail' },
      ]);
    }
    const row = await raw.$transaction(async (tx) => {
      const year = Number(wallClock(new Date(), RECEIPT_TIME_ZONE).date.slice(0, 4));
      // ON CONFLICT DO NOTHING makes the counter once; the update takes its row lock until the commit, so concurrent
      // records queue and a rollback gives the number back (gap-free, as invoice numbers, D-162).
      await tx.receiptNumberSequence.createMany({
        data: [{ year, lastValue: 0 }],
        skipDuplicates: true,
      });
      const { lastValue } = await tx.receiptNumberSequence.update({
        where: { year },
        data: { lastValue: { increment: 1 } },
        select: { lastValue: true },
      });
      const created = await tx.platformPayment.create({
        data: {
          officeId,
          receiptNumber: receiptNumber(year, lastValue),
          amount: roundMoney(body.amount, body.currency),
          currency: body.currency,
          method: body.method,
          reference: body.reference ?? null,
          paidAt: new Date(`${body.paidAt}T00:00:00Z`),
          recordedById: adminId,
        },
        select: SELECT,
      });
      await this.audit.log(
        {
          adminId,
          action: 'PAYMENT_RECORDED',
          entityType: 'PlatformPayment',
          entityId: created.id,
          targetOfficeId: officeId,
          newValues: { ...present(created), recordedBy: adminId, emailOffice: body.emailOffice },
        },
        client,
        tx,
      );
      return created;
    });
    await this.enqueue(officeId, {
      paymentId: row.id,
      language: pdfLanguageOf(office.defaultLanguage),
      email: body.emailOffice,
    });
    return present(row);
  }

  async void(
    paymentId: string,
    reason: string,
    adminId: string,
    client: ClientInfo,
  ): Promise<AdminPayment> {
    // unscoped: platform admin code voids any office's payment (D-080).
    const raw = this.prisma.unscoped();
    const row = await raw.$transaction(async (tx) => {
      const { count } = await tx.platformPayment.updateMany({
        where: { id: paymentId, voidedAt: null },
        data: { voidedAt: new Date(), voidedById: adminId, voidReason: reason },
      });
      const after = await tx.platformPayment.findUnique({
        where: { id: paymentId },
        select: SELECT,
      });
      if (!after) throw new ResourceNotFoundException();
      if (count === 0) throw new BusinessRuleException('BIZ-024', 'Payment already voided');
      await this.audit.log(
        {
          adminId,
          action: 'PAYMENT_VOIDED',
          entityType: 'PlatformPayment',
          entityId: paymentId,
          targetOfficeId: after.officeId,
          oldValues: { voidedAt: null },
          newValues: { voidedAt: after.voidedAt?.toISOString() ?? null, reason },
        },
        client,
        tx,
      );
      return after;
    });
    return present(row);
  }

  /** A link to the receipt as the payment is now (a voided one is stamped), or a render queued. */
  async receipt(
    paymentId: string,
    language: PdfLanguage | undefined,
    adminId: string,
    client: ClientInfo,
  ): Promise<PaymentReceipt> {
    // unscoped: platform admin code reads any office's receipt (D-080).
    const raw = this.prisma.unscoped();
    const row = await raw.platformPayment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        officeId: true,
        receiptNumber: true,
        updatedAt: true,
        pdfStorageKey: true,
        pdfLanguage: true,
        pdfRenderedFor: true,
        office: { select: { defaultLanguage: true } },
      },
    });
    if (!row) throw new ResourceNotFoundException();
    const lang = language ?? pdfLanguageOf(row.office.defaultLanguage);
    if (!receiptIsCurrent(row, lang) || !row.pdfStorageKey) {
      const minute = Math.floor(Date.now() / 60_000);
      await this.enqueue(
        row.officeId,
        { paymentId, language: lang, email: false },
        `${lang}-${row.updatedAt.getTime()}-${minute}`,
      );
      return { status: 'RENDERING' };
    }
    const key = row.pdfStorageKey;
    // The storage service accepts only keys of the current office: the link is made in the payment's office.
    const downloadUrl = await this.inOffice(row.officeId, () =>
      this.storage.presignedGetUrl(key, {
        expiresIn: LINK_TTL_SECONDS,
        filename: `${row.receiptNumber}.pdf`,
        contentType: 'application/pdf',
      }),
    );
    await this.audit.log(
      {
        adminId,
        action: 'PAYMENT_RECEIPT_DOWNLOADED',
        entityType: 'PlatformPayment',
        entityId: paymentId,
        targetOfficeId: row.officeId,
        newValues: { language: lang },
      },
      client,
    );
    return { status: 'READY', downloadUrl, expiresIn: LINK_TTL_SECONDS };
  }

  /** Queued in the paying office's context (the producer takes the office from it); after the commit. */
  private enqueue(officeId: string, job: ReceiptJob, suffix = 'record'): Promise<unknown> {
    return this.inOffice(officeId, () =>
      this.queues.enqueue(QUEUE.REPORT, RENDER_PAYMENT_RECEIPT_JOB, job, {
        jobId: `receipt-${job.paymentId}-${suffix}`,
      }),
    );
  }

  private inOffice<T>(officeId: string, work: () => Promise<T>): Promise<T> {
    const requestId = this.cls.isActive() ? this.cls.getId() : undefined;
    return this.tenant.run(
      { officeId: officeId as OfficeId, ...(requestId ? { requestId } : {}) },
      work,
    );
  }
}
