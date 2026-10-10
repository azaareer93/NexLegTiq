import type { ClsService } from 'nestjs-cls';

import { ClientContext, changedFields } from './client-context';
import type { RequestContext } from '../../common/context/request-context';

const clsWith = (values: Partial<Record<string, unknown>>) =>
  ({ get: (key: string) => values[key] }) as unknown as ClsService<RequestContext>;

describe('ClientContext', () => {
  const ctx = new ClientContext(clsWith({ officeId: 'office-1', userId: 'user-1' }));
  const caller = { ip: '10.0.0.1', userAgent: 'x'.repeat(600), requestId: 'req-12345678' };

  it('should never put encrypted fields in clear into an audit row', () => {
    const row = ctx.auditRow(
      caller,
      'Client',
      'client-1',
      'UPDATE',
      { nationalId: '401234567', taxId: null, phone: '1' },
      { nationalId: '999999999', taxId: '5', phone: '2' },
    );
    expect(row).toMatchObject({
      officeId: 'office-1',
      userId: 'user-1',
      entityType: 'Client',
      oldValues: { nationalId: '[encrypted]', taxId: null, phone: '1' },
      newValues: { nationalId: '[encrypted]', taxId: '[encrypted]', phone: '2' },
      ipAddress: '10.0.0.1',
      requestId: 'req-12345678',
    });
    expect(row.userAgent).toHaveLength(512);
    expect(ctx.auditRow(caller, 'Client', 'c', 'DELETE', null, null)).not.toHaveProperty(
      'oldValues',
    );
  });

  it('should fail loudly without a caller or office (a programming error, 500)', () => {
    const empty = new ClientContext(clsWith({}));
    expect(() => empty.actorId()).toThrow('No caller');
    expect(() => empty.officeId()).toThrow('No office');
  });
});

describe('changedFields', () => {
  it('should keep only sent fields whose value differs', () => {
    expect(
      changedFields(
        { displayName: 'A', phone: null, email: 'a@x.test', isActive: true },
        { displayName: 'A', phone: '0599', email: undefined, isActive: false },
      ),
    ).toEqual({ old: { phone: null, isActive: true }, next: { phone: '0599', isActive: false } });
  });
});
