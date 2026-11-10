import { InvoiceNumberService } from './invoice-number.service';

describe('InvoiceNumberService (D-162)', () => {
  const tx = (lastValue: number) => ({
    invoiceNumberSequence: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({ lastValue }),
    },
  });
  const service = (officeId?: string) =>
    new InvoiceNumberService({
      isActive: () => officeId !== undefined,
      get: () => officeId,
    } as never);

  it('should create the counter once, increment it and render the number', async () => {
    const t = tx(3);
    await expect(service('o1').next(t as never, 2026)).resolves.toBe('INV-2026-0003');
    expect(t.invoiceNumberSequence.createMany).toHaveBeenCalledWith({
      data: [{ officeId: 'o1', year: 2026, lastValue: 0 }],
      skipDuplicates: true,
    });
  });

  it('should refuse outside a tenant context', async () => {
    await expect(service().next(tx(1) as never, 2026)).rejects.toThrow();
  });
});
