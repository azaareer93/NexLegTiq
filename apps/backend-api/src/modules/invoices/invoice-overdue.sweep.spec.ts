import { InvoiceOverdueSweep } from './invoice-overdue.sweep';

describe('InvoiceOverdueSweep (D-162)', () => {
  function build(changed: { id: string }[]) {
    const tx = { $queryRaw: jest.fn().mockResolvedValue(changed) };
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

  it('should audit exactly the rows its single UPDATE returned, by the office date', async () => {
    const { sweep, tx, audit } = build([{ id: 'i1' }, { id: 'i2' }]);
    // 22:30 UTC on 1 Nov is already 2 Nov in Hebron: an invoice due on 1 Nov is overdue.
    await expect(sweep.run(new Date('2026-11-01T22:30:00Z'))).resolves.toEqual({ marked: 2 });
    expect(tx.$queryRaw.mock.calls[0]).toContain('2026-11-02');
    expect(audit.log.mock.calls.map((call) => call[1].entityId)).toEqual(['i1', 'i2']);
  });

  it('should audit nothing when the UPDATE changed nothing (a racing payment or void won)', async () => {
    const { sweep, audit } = build([]);
    await expect(sweep.run()).resolves.toEqual({ marked: 0 });
    expect(audit.log).not.toHaveBeenCalled();
  });
});
