import { InvoiceAccess } from './invoice-access';

const USER = '01920000-0000-7000-8000-0000000000aa';

function access(role: string, permissions: string[]) {
  const store: Record<string, unknown> = { userId: USER, role, officeId: 'o1', permissions };
  return new InvoiceAccess({ get: (key: string) => store[key] } as never);
}

describe('InvoiceAccess (D-162)', () => {
  it('should see every file as office manager, so no filter at all', () => {
    const a = access('OFFICE_MANAGER', ['view:all:invoices']);
    expect(a.fileScope()).toEqual({});
    expect(a.visibleWhere()).toEqual({});
  });

  it('should hide confidential files from other all-invoice roles and limit assigned roles', () => {
    expect(access('ADMIN', ['view:all:invoices']).fileScope()).toMatchObject({
      OR: [{ isConfidential: false }, { OR: expect.any(Array) }],
    });
    const assigned = access('LAWYER', ['view:assigned:invoices']);
    expect(assigned.fileScope()).toMatchObject({ OR: expect.any(Array) });
    expect(assigned.visibleWhere()).toMatchObject({ AND: expect.any(Array) });
  });

  it('should refuse a missing caller', () => {
    const a = new InvoiceAccess({ get: () => undefined } as never);
    expect(() => a.caller()).toThrow('No office caller');
  });

  describe('locked', () => {
    const tx = (row: object | null) => ({
      $queryRaw: jest.fn(),
      invoice: { findFirst: jest.fn().mockResolvedValue(row) },
    });
    const a = access('OFFICE_MANAGER', ['view:all:invoices']);

    it('should return an invoice in an allowed status', async () => {
      await expect(
        a.locked(tx({ id: 'i1', status: 'DRAFT' }) as never, 'i1', ['DRAFT']),
      ).resolves.toMatchObject({ id: 'i1' });
    });

    it('should answer 404 when not visible and BIZ-006 in the wrong status', async () => {
      await expect(a.locked(tx(null) as never, 'i1', ['DRAFT'])).rejects.toMatchObject({
        code: 'RES-001',
      });
      await expect(
        a.locked(tx({ id: 'i1', status: 'PAID' }) as never, 'i1', ['DRAFT']),
      ).rejects.toMatchObject({ code: 'BIZ-006' });
    });
  });
});
