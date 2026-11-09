import { PlatformOfficesService } from './platform-offices.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';

const client = { ip: '127.0.0.1', userAgent: null, requestId: null };

function build(updated: number, exists: boolean) {
  const tx = {
    office: { updateMany: jest.fn().mockResolvedValue({ count: updated }) },
    refreshToken: { updateMany: jest.fn() },
  };
  const raw = {
    $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)),
    office: { findUnique: jest.fn().mockResolvedValue(exists ? { id: 'x' } : null) },
  };
  const audit = { log: jest.fn() };
  const entitlements = { invalidate: jest.fn() };
  const service = new PlatformOfficesService(
    { unscoped: () => raw } as never,
    audit as never,
    entitlements as never,
  );
  const detail = jest.spyOn(service, 'get').mockResolvedValue({} as never);
  return { service, audit, entitlements, detail };
}

describe('PlatformOfficesService suspend', () => {
  it('should audit and drop cached entitlements when the office changed state', async () => {
    const { service, audit, entitlements } = build(1, true);
    await service.suspend('o1', 'abuse', 'a1', client);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'OFFICE_SUSPENDED', newValues: { reason: 'abuse' } }),
      client,
      expect.anything(),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith('o1');
  });

  it('should do nothing when the office is already in that state', async () => {
    const { service, audit, entitlements } = build(0, true);
    await service.reactivate('o1', undefined, 'a1', client);
    expect(audit.log).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it('should answer 404 for an unknown office', async () => {
    const { service } = build(0, false);
    await expect(service.suspend('o1', 'abuse', 'a1', client)).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
  });
});
