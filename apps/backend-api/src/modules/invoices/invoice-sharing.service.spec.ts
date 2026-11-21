import { InvoiceSharing } from './invoice-sharing.service';

const UPDATED = new Date('2026-11-14T08:00:00Z');

function setup(sharedWithClient: boolean, locked: object = {}) {
  const tx = {
    invoice: {
      findFirstOrThrow: jest.fn().mockResolvedValue({ sharedWithClient, updatedAt: UPDATED }),
      update: jest.fn(),
    },
  };
  const access = {
    locked: jest.fn().mockResolvedValue({
      fileId: 'f1',
      invoiceNumber: 'INV-2026-0001',
      lines: [{ fileId: 'f1' }, { fileId: 'f2' }, { fileId: null }],
      ...locked,
    }),
  };
  const audit = { log: jest.fn() };
  const timeline = { record: jest.fn() };
  const sharing = new InvoiceSharing(
    { run: (work: (t: typeof tx) => Promise<void>) => work(tx) } as never,
    access as never,
    audit as never,
    timeline as never,
  );
  return { sharing, tx, access, audit, timeline };
}

describe('InvoiceSharing (D-188)', () => {
  it('should share an issued invoice, keep its PDF current, audit it and mark every billed file', async () => {
    const { sharing, tx, access, audit, timeline } = setup(false);
    await sharing.setShared('i1', true);
    expect(access.locked).toHaveBeenCalledWith(tx, 'i1', ['SENT', 'OVERDUE', 'PAID']);
    expect(tx.invoice.update).toHaveBeenCalledWith({
      where: { id: 'i1' },
      data: { sharedWithClient: true, updatedAt: UPDATED },
    });
    expect(audit.log).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ newValues: { sharedWithClient: true } }),
    );
    expect(timeline.record.mock.calls.map((call) => call[1].fileId)).toEqual(['f1', 'f2']);
    expect(timeline.record.mock.calls[0][1]).toMatchObject({
      eventType: 'INVOICE_SHARED',
      payload: { invoiceNumber: 'INV-2026-0001' },
    });
  });

  it('should withdraw in any state without a timeline event, and write nothing when unchanged', async () => {
    const withdraw = setup(true, { fileId: null, lines: [] });
    await withdraw.sharing.setShared('i1', false);
    expect(withdraw.access.locked.mock.calls[0][2]).toContain('VOID');
    expect(withdraw.audit.log).toHaveBeenCalled();
    expect(withdraw.timeline.record).not.toHaveBeenCalled();
    const same = setup(true);
    await same.sharing.setShared('i1', true);
    expect(same.tx.invoice.update).not.toHaveBeenCalled();
    expect(same.audit.log).not.toHaveBeenCalled();
  });
});
