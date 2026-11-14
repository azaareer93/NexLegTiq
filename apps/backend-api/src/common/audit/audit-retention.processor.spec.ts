import { UnrecoverableError } from 'bullmq';

import {
  AuditRetentionProcessor,
  MARK_OVERDUE_INVOICES_JOB,
  PURGE_AUDIT_LOGS_JOB,
} from './audit-retention.processor';
import { RENDER_INVOICE_PDF_JOB } from '../../modules/invoices/pdf/invoice-pdf.renderer';
import { RENDER_PAYMENT_RECEIPT_JOB } from '../../modules/platform-payments/receipt-pdf.renderer';
import { TenantProcessor } from '../queue/tenant-processor';

function build(queue: unknown = { upsertJobScheduler: jest.fn() }) {
  const raw = {
    office: { findMany: jest.fn().mockResolvedValue([{ id: 'o1' }, { id: 'o2' }]) },
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce([{ removed: 3 }])
      .mockResolvedValueOnce([]),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), setContext: jest.fn() };
  const moduleRef = {
    get: jest.fn(() => {
      if (!queue) throw new Error('Redis down');
      return queue;
    }),
  };
  const overdue = { run: jest.fn().mockResolvedValue({ marked: 1 }) };
  const pdfs = { run: jest.fn().mockResolvedValue({ rendered: true }) };
  const receipts = { run: jest.fn().mockResolvedValue({ rendered: true, emailed: true }) };
  const processor = new AuditRetentionProcessor(
    {} as never,
    { unscoped: () => raw } as never,
    logger as never,
    moduleRef as never,
    overdue as never,
    pdfs as never,
    receipts as never,
  );
  return { processor, logger, overdue, pdfs, receipts };
}

const ID = '01920000-0000-7000-8000-000000000001';
const job = (name: string, data: object = {}) => ({ name, data, id: 'j1' }) as never;

describe('AuditRetentionProcessor', () => {
  it('should register both daily schedulers, and only log when Redis is down at boot', async () => {
    const queue = { upsertJobScheduler: jest.fn() };
    await build(queue).processor.onApplicationBootstrap();
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(2);

    const down = build(null);
    await down.processor.onApplicationBootstrap();
    expect(down.logger.warn).toHaveBeenCalled();
  });

  it('should purge office by office, counting an office that returned no row as none', async () => {
    const { processor } = build();
    await expect(processor.process(job(PURGE_AUDIT_LOGS_JOB))).resolves.toEqual({ removed: 3 });
  });

  it("should run the overdue sweep for the scheduler's job only", async () => {
    const { processor, overdue } = build();
    await expect(processor.process(job(MARK_OVERDUE_INVOICES_JOB))).resolves.toEqual({
      marked: 1,
    });
    const tenant = jest.spyOn(TenantProcessor.prototype, 'process').mockResolvedValue('tenant');
    await expect(
      processor.process(job(MARK_OVERDUE_INVOICES_JOB, { officeId: 'o1' })),
    ).resolves.toBe('tenant');
    // A job without data is the scheduler's too.
    await processor.process({
      name: MARK_OVERDUE_INVOICES_JOB,
      data: undefined,
      id: 'j2',
    } as never);
    expect(overdue.run).toHaveBeenCalledTimes(2);
    tenant.mockRestore();
  });

  it('should render an invoice PDF or a payment receipt by job name, and refuse an unknown office job', async () => {
    const { processor, pdfs, receipts } = build();
    const handle = (name: string, data: object) =>
      (
        processor as unknown as {
          handle: (j: unknown, s: AbortSignal) => Promise<unknown>;
        }
      ).handle(job(name, data), new AbortController().signal);
    const invoice = { invoiceId: ID, language: 'AR' };
    await expect(handle(RENDER_INVOICE_PDF_JOB, invoice)).resolves.toEqual({ rendered: true });
    expect(pdfs.run).toHaveBeenCalledWith(
      { ...invoice, email: false },
      'j1',
      expect.any(AbortSignal),
    );
    const receipt = { paymentId: ID, language: 'EN', email: true };
    await expect(handle(RENDER_PAYMENT_RECEIPT_JOB, receipt)).resolves.toMatchObject({
      emailed: true,
    });
    expect(receipts.run).toHaveBeenCalledWith(receipt, 'j1', expect.any(AbortSignal));
    // A receipt payload under the invoice job name is refused by the invoice schema.
    expect(() => handle(RENDER_INVOICE_PDF_JOB, receipt)).toThrow(UnrecoverableError);
    expect(() => handle('nope', invoice)).toThrow(UnrecoverableError);
  });
});
