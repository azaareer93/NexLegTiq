import { InvoiceOverdueSweep } from './invoice-overdue.sweep';

describe('InvoiceOverdueSweep (D-162)', () => {
  function build(due: { id: string }[]) {
    const tx = {
      invoice: {
        findMany: jest.fn().mockResolvedValue(due),
        updateMany: jest.fn().mockResolvedValue({ count: due.length }),
      },
    };
    const audit = { log: jest.fn() };
    const prisma = {
      unscoped: () => ({
        office: {
          findMany: jest.fn().mockResolvedValue([{ id: 'o1', timezone: 'Asia/Hebron' }]),
        },
      }),
    };
    const sweep = new InvoiceOverdueSweep(
      prisma as never,
      { run: (_ctx: unknown, work: () => Promise<unknown>) => work() } as never,
      { run: (work: (t: unknown) => Promise<unknown>) => work(tx) } as never,
      audit as never,
      { setContext: jest.fn(), info: jest.fn() } as never,
    );
    return { sweep, tx, audit };
  }

  it('should mark due invoices overdue by the office date and audit each', async () => {
    const { sweep, tx, audit } = build([{ id: 'i1' }, { id: 'i2' }]);
    // 22:30 UTC on 1 Nov is already 2 Nov in Hebron: an invoice due on 1 Nov is overdue.
    await expect(sweep.run(new Date('2026-11-01T22:30:00Z'))).resolves.toEqual({ marked: 2 });
    expect(tx.invoice.findMany.mock.calls[0][0].where.dueDate.lt).toEqual(
      new Date('2026-11-02T00:00:00Z'),
    );
    expect(audit.log).toHaveBeenCalledTimes(2);
  });

  it('should do nothing when no invoice is due', async () => {
    const { sweep, tx } = build([]);
    await expect(sweep.run()).resolves.toEqual({ marked: 0 });
    expect(tx.invoice.updateMany).not.toHaveBeenCalled();
  });
});
