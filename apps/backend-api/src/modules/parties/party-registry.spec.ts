import type { ClsService } from 'nestjs-cls';

import { PartyRegistry } from './party-registry';
import type { RequestContext } from '../../common/context/request-context';
import type { FieldCipher } from '../../common/crypto/field-cipher';
import type { PrismaService } from '../../database/prisma.service';
import type { ScopedTransaction } from '../../database/unit-of-work';

const cipher = {
  encrypt: jest.fn((value: string) => `v1:${value}`),
  decrypt: jest.fn((value: string) => value.replace(/^v1:/, '')),
  blindIndex: jest.fn((value: string | undefined) => (value ? `idx-${value}` : null)),
};
const make = (values: Record<string, unknown>) =>
  new PartyRegistry(
    {} as PrismaService,
    { get: (key: string) => values[key] } as unknown as ClsService<RequestContext>,
    cipher as unknown as FieldCipher,
  );

describe('PartyRegistry', () => {
  it('should refuse to work without an office or a caller', () => {
    expect(() => make({}).officeId()).toThrow('No office');
    expect(() => make({}).actorId()).toThrow('No caller');
    expect(make({ userId: 'u1' }).actorId()).toBe('u1');
  });

  it('should open encrypted fields and pass legacy plaintext through', () => {
    const registry = make({ officeId: 'o1' });
    const party = {
      id: 'p1',
      isIndividual: true,
      fullName: 'Layla',
      companyName: null,
      phone: null,
      email: null,
      nationalId: 'v1:123456789',
      taxId: 'plain-tax',
      notes: null,
      address: null,
      legalRepresentative: null,
    };
    const view = registry.present({
      id: 'fp1',
      partyType: 'PLAINTIFF',
      roleLabel: null,
      joinedAt: new Date('2026-11-01T00:00:00Z'),
      party,
    } as never);
    expect(view.party).toMatchObject({ nationalId: '123456789', taxId: 'plain-tax', notes: null });
  });

  it('should seal identifiers on create and audit them as encrypted, omitting absent ones', async () => {
    const registry = make({ officeId: 'o1', userId: 'u1' });
    const tx = {
      party: { create: jest.fn().mockResolvedValue({ id: 'p1' }) },
      auditLog: { create: jest.fn() },
    };
    await registry.create(
      tx as unknown as ScopedTransaction,
      { isIndividual: true, fullName: 'Layla', nationalId: '123', notes: 'n' } as never,
      {} as never,
    );
    const data = tx.party.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ nationalId: 'v1:123', taxId: null, notes: 'v1:n' });
    const audit = JSON.stringify(tx.auditLog.create.mock.calls[0][0].data.newValues);
    expect(audit).toContain('[encrypted]');
    expect(audit).not.toContain('taxId');
    expect(audit).not.toContain('"123"');
  });
});
