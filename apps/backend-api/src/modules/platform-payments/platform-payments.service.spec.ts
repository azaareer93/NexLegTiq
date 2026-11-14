import { PlatformPaymentsService, receiptNumber } from './platform-payments.service';

const client = { ip: '1.2.3.4', userAgent: null, requestId: 'r1' };
const OFFICE = '01920000-0000-7000-8000-000000000001';
const PAY = '01920000-0000-7000-8000-0000000000c1';
const UPDATED = new Date('2026-11-14T10:00:00Z');

function paymentRow(over: Record<string, unknown> = {}) {
  return {
    id: PAY,
    officeId: OFFICE,
    receiptNumber: 'RCT-2026-0001',
    amount: { toFixed: () => '150.5' },
    currency: 'ILS',
    method: 'CASH',
    reference: null,
    paidAt: new Date('2026-11-14T00:00:00Z'),
    voidedAt: null,
    voidReason: null,
    createdAt: UPDATED,
    recordedBy: { id: 'a1', fullName: 'Admin' },
    ...over,
  };
}

interface Options {
  readonly office?: object | null;
  readonly voided?: number;
  readonly found?: object | null;
  readonly enqueueFails?: boolean;
  readonly inRequest?: boolean;
}

function build({
  office = {
    name: 'O',
    address: null,
    timezone: 'Asia/Hebron',
    email: 'o@x.test',
    defaultLanguage: 'EN',
  },
  voided = 1,
  found = paymentRow(),
  enqueueFails = false,
  inRequest = true,
}: Options = {}) {
  const tx = {
    receiptNumberSequence: {
      createMany: jest.fn(),
      update: jest.fn().mockResolvedValue({ lastValue: 7 }),
    },
    platformPayment: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...paymentRow(),
        ...data,
        amount: { toFixed: () => String(data['amount']) },
      })),
      updateMany: jest.fn().mockResolvedValue({ count: voided }),
      findUnique: jest.fn().mockResolvedValue(found),
    },
  };
  const raw = {
    ...tx,
    office: { findUnique: jest.fn().mockResolvedValue(office) },
    platformPayment: {
      ...tx.platformPayment,
      findMany: jest.fn().mockResolvedValue([paymentRow()]),
    },
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  const audit = { log: jest.fn() };
  const queues = {
    enqueue: enqueueFails
      ? jest.fn().mockRejectedValue(new Error('redis down'))
      : jest.fn().mockResolvedValue({}),
  };
  const tenant = { run: jest.fn((_ctx: unknown, work: () => unknown) => work()) };
  const storage = { presignedGetUrl: jest.fn().mockResolvedValue('https://s3.test/r.pdf') };
  const cls = { isActive: () => inRequest, getId: () => 'req-1' };
  const logger = { setContext: jest.fn(), error: jest.fn() };
  const service = new PlatformPaymentsService(
    { unscoped: () => raw } as never,
    audit as never,
    queues as never,
    tenant as never,
    storage as never,
    cls as never,
    logger as never,
  );
  return { service, tx, raw, audit, queues, tenant, storage, logger };
}

const body = (over: Record<string, unknown> = {}) => ({
  amount: '150.50',
  currency: 'ILS',
  method: 'CASH' as const,
  paidAt: '2026-11-14',
  emailOffice: true,
  ...over,
});

describe('receiptNumber', () => {
  it('should pad to four digits and grow past them', () => {
    expect(receiptNumber(2026, 7)).toBe('RCT-2026-0007');
    expect(receiptNumber(2026, 10000)).toBe('RCT-2026-10000');
  });
});

describe('PlatformPaymentsService', () => {
  it('should record with the next number, the payer frozen, audit it and queue the emailed receipt in the office', async () => {
    const { service, tx, audit, queues, tenant } = build();
    const paid = await service.record(OFFICE, body(), 'a1', client);
    expect(paid.amount).toBe('150.50');
    const data = tx.platformPayment.create.mock.calls[0]?.[0].data as Record<string, unknown>;
    expect(data).toMatchObject({ payerName: 'O', payerEmail: 'o@x.test', recordedById: 'a1' });
    expect(data['receiptNumber']).toMatch(/^RCT-\d{4}-0007$/);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_RECORDED', targetOfficeId: OFFICE }),
      client,
      tx,
    );
    expect(tenant.run).toHaveBeenCalledWith(
      { officeId: OFFICE, requestId: 'req-1' },
      expect.any(Function),
    );
    expect(queues.enqueue).toHaveBeenCalledWith(
      'report',
      'render-payment-receipt',
      { paymentId: PAY, language: 'EN', email: true },
      { jobId: `receipt-${PAY}-record` },
    );
  });

  it('should still answer when the queue is down, logging it', async () => {
    const { service, logger } = build({ enqueueFails: true });
    await expect(service.record(OFFICE, body(), 'a1', client)).resolves.toMatchObject({ id: PAY });
    expect(logger.error).toHaveBeenCalled();
  });

  it.each([
    ['too many decimals', body({ amount: '1.005' }), 'amount'],
    ['a future day', body({ paidAt: '2999-01-01' }), 'paidAt'],
  ])('should refuse %s', async (_label, input, field) => {
    const { service } = build();
    await expect(service.record(OFFICE, input, 'a1', client)).rejects.toMatchObject({
      details: [expect.objectContaining({ field })],
    });
  });

  it('should accept trailing zeros, and refuse emailing an office without an address', async () => {
    const { service } = build();
    await expect(
      service.record(OFFICE, body({ amount: '10.500' }), 'a1', client),
    ).resolves.toBeTruthy();
    const noEmail = build({
      office: {
        name: 'O',
        address: null,
        timezone: 'Asia/Hebron',
        email: null,
        defaultLanguage: 'AR',
      },
    });
    await expect(noEmail.service.record(OFFICE, body(), 'a1', client)).rejects.toMatchObject({
      details: [expect.objectContaining({ field: 'emailOffice' })],
    });
    await expect(
      noEmail.service.record(OFFICE, body({ emailOffice: false }), 'a1', client),
    ).resolves.toBeTruthy();
  });

  it('should answer 404 for an unknown office on record and list', async () => {
    const { service } = build({ office: null });
    await expect(service.record(OFFICE, body(), 'a1', client)).rejects.toMatchObject({
      code: 'RES-001',
    });
    await expect(service.list(OFFICE)).rejects.toMatchObject({ code: 'RES-001' });
  });

  it('should list the newest 100 payments', async () => {
    const { service, raw } = build();
    await expect(service.list(OFFICE)).resolves.toHaveLength(1);
    expect(raw.platformPayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });

  it('should void once: unknown → 404, already voided → BIZ-024', async () => {
    const ok = build({ found: paymentRow({ voidedAt: UPDATED, voidReason: 'twice' }) });
    await expect(ok.service.void(PAY, 'twice', 'a1', client)).resolves.toMatchObject({
      voidReason: 'twice',
    });
    expect(ok.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_VOIDED' }),
      client,
      ok.tx,
    );
    await expect(build({ found: null }).service.void(PAY, 'x', 'a1', client)).rejects.toMatchObject(
      { code: 'RES-001' },
    );
    await expect(build({ voided: 0 }).service.void(PAY, 'x', 'a1', client)).rejects.toMatchObject({
      code: 'BIZ-024',
    });
  });

  it('should queue a render for a stale receipt and hand out a link, audited, for a current one', async () => {
    const stale = {
      ...paymentRow(),
      updatedAt: UPDATED,
      pdfStorageKey: null,
      pdfLanguage: null,
      pdfRenderedFor: null,
      office: { defaultLanguage: 'BILINGUAL' },
    };
    const pending = build({ found: stale });
    await expect(pending.service.receipt(PAY, undefined, 'a1', client)).resolves.toEqual({
      status: 'RENDERING',
    });
    expect(pending.queues.enqueue.mock.calls[0]?.[2]).toEqual({
      paymentId: PAY,
      language: 'AR',
      email: false,
    });

    const current = {
      ...stale,
      pdfStorageKey: `${OFFICE}/receipts/r.pdf`,
      pdfLanguage: 'EN',
      pdfRenderedFor: UPDATED,
    };
    const ready = build({ found: current });
    await expect(ready.service.receipt(PAY, 'EN', 'a1', client)).resolves.toEqual({
      status: 'READY',
      downloadUrl: 'https://s3.test/r.pdf',
      expiresIn: 300,
    });
    expect(ready.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PAYMENT_RECEIPT_DOWNLOADED' }),
      client,
    );
    await expect(
      build({ found: null }).service.receipt(PAY, 'EN', 'a1', client),
    ).rejects.toMatchObject({ code: 'RES-001' });
  });

  it('should take a whole amount and queue without a request id outside a request', async () => {
    const { service, tenant } = build({ inRequest: false });
    await expect(
      service.record(OFFICE, body({ amount: '75' }), 'a1', client),
    ).resolves.toBeTruthy();
    expect(tenant.run).toHaveBeenCalledWith({ officeId: OFFICE }, expect.any(Function));
  });
});
