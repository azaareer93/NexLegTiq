import type { ClsService } from 'nestjs-cls';

import { FileNumberService } from './file-number.service';
import type { RequestContext } from '../../common/context/request-context';
import type { ScopedTransaction } from '../../database/unit-of-work';

function setup(format: string | null, taken: string[] = []) {
  let last = 0;
  const tx = {
    officeSettings: {
      findFirst: jest.fn().mockResolvedValue(format === null ? null : { fileNumberFormat: format }),
    },
    fileNumberSequence: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockImplementation(() => ({ lastValue: (last += 1) })),
    },
    legalFile: {
      findFirst: jest.fn(({ where }: { where: { fileNumber: string } }) =>
        taken.includes(where.fileNumber) ? { id: 'f' } : null,
      ),
    },
  };
  const cls = { isActive: () => true, get: () => 'o1' };
  const service = new FileNumberService(cls as unknown as ClsService<RequestContext>);
  return { service, tx: tx as unknown as ScopedTransaction, raw: tx };
}

describe('FileNumberService (D-095)', () => {
  it('should number per year and type when the format shows them, skipping a number already taken', async () => {
    const { service, tx, raw } = setup('{YEAR}-{TYPE}-{SEQ:5}', ['2026-LIT-00001']);
    await expect(service.next(tx, 'LITIGATION', 2026)).resolves.toBe('2026-LIT-00002');
    expect(raw.fileNumberSequence.createMany).toHaveBeenCalledWith({
      data: [{ officeId: 'o1', year: 2026, typeCode: 'LIT', lastValue: 0 }],
      skipDuplicates: true,
    });
  });

  it('should share one counter when the format shows neither year nor type', async () => {
    const { service, tx, raw } = setup('F-{SEQ}');
    await expect(service.next(tx, 'CONTRACT_DRAFTING', 2026)).resolves.toBe('F-1');
    expect(raw.fileNumberSequence.createMany).toHaveBeenCalledWith({
      data: [{ officeId: 'o1', year: 0, typeCode: '', lastValue: 0 }],
      skipDuplicates: true,
    });
  });

  it('should refuse a year that is not four digits, a missing settings row and a missing office', async () => {
    const { service, tx } = setup('{SEQ}');
    await expect(service.next(tx, 'LITIGATION', 26)).rejects.toThrow(RangeError);
    await expect(service.next(tx, 'LITIGATION', 2026.5)).rejects.toThrow(RangeError);
    const missing = setup(null);
    await expect(missing.service.next(missing.tx, 'LITIGATION', 2026)).rejects.toThrow(
      'Office settings missing',
    );
    const outside = new FileNumberService({
      isActive: () => false,
      get: () => undefined,
    } as unknown as ClsService<RequestContext>);
    await expect(outside.next(tx, 'LITIGATION', 2026)).rejects.toThrow();
  });
});
