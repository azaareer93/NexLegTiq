import { assertRawQueryScoped, scopeArgs } from './tenant-scope';
import type { RelationMap, ScopeContext } from './tenant-scope';
import { TenantContextMissingError, TenantViolationError } from './tenant.errors';

const A = '01920000-0000-7000-8000-00000000000a';
const B = '01920000-0000-7000-8000-00000000000b';

// A slice of the real schema: tenant models User/Notification/Subscription, the Office root, global Plan.
const relations: RelationMap = new Map([
  [
    'Office',
    new Map([
      ['users', 'User'],
      ['subscriptions', 'Subscription'],
      ['settings', 'OfficeSettings'],
    ]),
  ],
  [
    'User',
    new Map([
      ['office', 'Office'],
      ['notifications', 'Notification'],
    ]),
  ],
  [
    'Notification',
    new Map([
      ['office', 'Office'],
      ['user', 'User'],
    ]),
  ],
  [
    'Subscription',
    new Map([
      ['office', 'Office'],
      ['plan', 'Plan'],
    ]),
  ],
  ['Plan', new Map([['subscriptions', 'Subscription']])],
]);

function ctx(officeId: string | null = A): ScopeContext {
  return {
    tenantModels: new Set(['User', 'Notification', 'Subscription', 'OfficeSettings']),
    relations,
    officeId: () => officeId ?? undefined,
  };
}

describe('scopeArgs — tenant models', () => {
  it.each([
    'findUnique',
    'findUniqueOrThrow',
    'findFirst',
    'findFirstOrThrow',
    'findMany',
    'count',
    'aggregate',
    'groupBy',
  ])('should add officeId to where for %s', (operation) => {
    expect(scopeArgs('User', operation, { where: { id: 'u1' } }, ctx())).toEqual({
      where: { id: 'u1', officeId: A },
    });
  });

  it('should add a where when the caller passed none', () => {
    expect(scopeArgs('User', 'findMany', undefined, ctx())).toEqual({ where: { officeId: A } });
  });

  it.each(['update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany'])(
    'should scope where for %s',
    (operation) => {
      expect(
        scopeArgs('User', operation, { where: { id: 'u1' }, data: { fullName: 'x' } }, ctx()),
      ).toMatchObject({
        where: { id: 'u1', officeId: A },
      });
    },
  );

  it('should inject officeId into create, createMany and createManyAndReturn rows', () => {
    expect(
      scopeArgs('Notification', 'create', { data: { userId: 'u1', type: 't' } }, ctx()),
    ).toEqual({
      data: { userId: 'u1', type: 't', officeId: A },
    });
    for (const operation of ['createMany', 'createManyAndReturn']) {
      expect(
        scopeArgs('Notification', operation, { data: [{ type: 'a' }, { type: 'b' }] }, ctx()),
      ).toEqual({
        data: [
          { type: 'a', officeId: A },
          { type: 'b', officeId: A },
        ],
      });
    }
  });

  it('should scope upsert where, create and update', () => {
    expect(
      scopeArgs(
        'User',
        'upsert',
        { where: { email: 'e' }, create: { email: 'e' }, update: { fullName: 'n' } },
        ctx(),
      ),
    ).toEqual({
      where: { email: 'e', officeId: A },
      create: { email: 'e', officeId: A },
      update: { fullName: 'n' },
    });
  });

  it('should accept the current officeId passed explicitly', () => {
    expect(scopeArgs('User', 'create', { data: { officeId: A } }, ctx())).toEqual({
      data: { officeId: A },
    });
    expect(scopeArgs('User', 'findMany', { where: { officeId: A } }, ctx())).toEqual({
      where: { officeId: A },
    });
  });

  it.each([
    ['create with a foreign officeId', 'create', { data: { officeId: B } }],
    ['createMany with one foreign row', 'createMany', { data: [{ officeId: A }, { officeId: B }] }],
    ['update moving the row', 'update', { where: { id: 'u1' }, data: { officeId: B } }],
    [
      'upsert creating elsewhere',
      'upsert',
      { where: { id: 'u1' }, create: { officeId: B }, update: {} },
    ],
    ['where naming another office', 'findMany', { where: { officeId: B } }],
    ['where with an officeId filter object', 'findMany', { where: { officeId: { in: [A, B] } } }],
  ])('should reject %s', (_label, operation, args) => {
    expect(() => scopeArgs('User', operation, args, ctx())).toThrow(TenantViolationError);
  });

  it('should throw TenantContextMissingError without an office in context', () => {
    expect(() => scopeArgs('User', 'findMany', {}, ctx(null))).toThrow(TenantContextMissingError);
  });
});

describe('scopeArgs — nested writes', () => {
  it.each([
    'create',
    'createMany',
    'connect',
    'connectOrCreate',
    'upsert',
    'update',
    'set',
    'delete',
  ])('should reject a nested %s into a tenant model', (op) => {
    const data = { fullName: 'x', notifications: { [op]: { id: 'n1' } } };
    expect(() => scopeArgs('User', 'update', { where: { id: 'u1' }, data }, ctx())).toThrow(
      TenantViolationError,
    );
    expect(() => scopeArgs('User', 'create', { data }, ctx())).toThrow(TenantViolationError);
  });

  it('should reject connecting a tenant row to an office through the relation', () => {
    expect(() =>
      scopeArgs('Notification', 'create', { data: { office: { connect: { id: B } } } }, ctx()),
    ).toThrow(TenantViolationError);
  });

  it('should allow relation writes into global models', () => {
    expect(
      scopeArgs('Subscription', 'create', { data: { plan: { connect: { id: 'p1' } } } }, ctx()),
    ).toEqual({
      data: { plan: { connect: { id: 'p1' } }, officeId: A },
    });
  });

  it('should find tenant writes nested under a global model', () => {
    const data = {
      plan: { create: { code: 'X', subscriptions: { create: { status: 'ACTIVE' } } } },
    };
    expect(() => scopeArgs('Subscription', 'create', { data }, ctx())).toThrow(
      TenantViolationError,
    );
    expect(() =>
      scopeArgs(
        'Plan',
        'update',
        { where: { id: 'p1' }, data: { subscriptions: { deleteMany: {} } } },
        ctx(),
      ),
    ).toThrow(TenantViolationError);
  });

  it('should not treat a scalar or JSON field named like an operation as a relation', () => {
    expect(
      scopeArgs(
        'Notification',
        'create',
        { data: { type: 't', params: { create: { anything: true } } } },
        ctx(),
      ),
    ).toEqual({
      data: { type: 't', params: { create: { anything: true } }, officeId: A },
    });
  });
});

describe('scopeArgs — Office and global models', () => {
  it('should limit Office reads and updates to the current office', () => {
    expect(scopeArgs('Office', 'findMany', {}, ctx())).toEqual({ where: { id: A } });
    expect(scopeArgs('Office', 'update', { where: { id: A }, data: { name: 'n' } }, ctx())).toEqual(
      {
        where: { id: A },
        data: { name: 'n' },
      },
    );
    expect(() => scopeArgs('Office', 'findUnique', { where: { id: B } }, ctx())).toThrow(
      TenantViolationError,
    );
  });

  it.each(['create', 'createMany', 'delete', 'deleteMany', 'upsert'])(
    'should reject Office.%s on the scoped client',
    (op) => {
      expect(() => scopeArgs('Office', op, { data: {} }, ctx())).toThrow(/unscoped/);
    },
  );

  it('should leave global models alone without needing an office', () => {
    expect(scopeArgs('Plan', 'findMany', { where: { isActive: true } }, ctx(null))).toEqual({
      where: { isActive: true },
    });
  });

  it('should filter tenant lists included from a global model, at any depth', () => {
    expect(scopeArgs('Plan', 'findMany', { include: { subscriptions: true } }, ctx())).toEqual({
      include: { subscriptions: { where: { officeId: A } } },
    });
    expect(
      scopeArgs(
        'Subscription',
        'findMany',
        { include: { plan: { include: { subscriptions: { where: { status: 'ACTIVE' } } } } } },
        ctx(),
      ),
    ).toEqual({
      where: { officeId: A },
      include: {
        plan: { include: { subscriptions: { where: { status: 'ACTIVE', officeId: A } } } },
      },
    });
  });

  it('should filter _count of tenant relations from a global model', () => {
    expect(scopeArgs('Plan', 'findMany', { select: { _count: true } }, ctx())).toEqual({
      select: { _count: { select: { subscriptions: { where: { officeId: A } } } } },
    });
    expect(
      scopeArgs(
        'Plan',
        'findMany',
        { select: { _count: { select: { subscriptions: true } } } },
        ctx(),
      ),
    ).toEqual({
      select: { _count: { select: { subscriptions: { where: { officeId: A } } } } },
    });
  });

  it('should need an office to include tenant rows from a global model', () => {
    expect(() =>
      scopeArgs('Plan', 'findMany', { include: { subscriptions: true } }, ctx(null)),
    ).toThrow(TenantContextMissingError);
  });
});

describe('assertRawQueryScoped', () => {
  const tables = ['users', 'notifications'];
  const sql = (
    strings: string[],
    ...values: unknown[]
  ): { strings: string[]; values: unknown[] } => ({ strings, values });

  it('should allow raw SQL that does not touch tenant tables', () => {
    expect(() =>
      assertRawQueryScoped('$queryRaw', sql(['SELECT 1']), tables, () => undefined),
    ).not.toThrow();
    expect(() =>
      assertRawQueryScoped(
        '$queryRaw',
        sql(['SELECT nlq_normalize_ar(', ')'], 'x'),
        tables,
        () => A,
      ),
    ).not.toThrow();
  });

  it('should allow a tenant table when the current officeId is a parameter', () => {
    const query = sql(['SELECT * FROM "users" WHERE office_id = ', '::uuid'], A);
    expect(() => assertRawQueryScoped('$queryRaw', query, tables, () => A)).not.toThrow();
    expect(() =>
      assertRawQueryScoped(
        '$executeRaw',
        ['UPDATE notifications SET read_at = now() WHERE office_id = ', A],
        tables,
        () => A,
      ),
    ).not.toThrow();
  });

  it.each([
    ['without the officeId parameter', sql(['SELECT * FROM users'])],
    ['with another office as parameter', sql(['SELECT * FROM users WHERE office_id = ', ''], B)],
  ])('should reject a tenant table %s', (_label, query) => {
    expect(() => assertRawQueryScoped('$queryRaw', query, tables, () => A)).toThrow(
      TenantViolationError,
    );
  });

  it('should need an office for raw SQL on tenant tables', () => {
    expect(() =>
      assertRawQueryScoped('$queryRaw', sql(['SELECT * FROM users']), tables, () => undefined),
    ).toThrow(TenantContextMissingError);
  });

  it('should never allow the Unsafe variants', () => {
    expect(() => assertRawQueryScoped('$queryRawUnsafe', 'SELECT 1', tables, () => A)).toThrow(
      /not allowed/,
    );
    expect(() => assertRawQueryScoped('$executeRawUnsafe', 'SELECT 1', tables, () => A)).toThrow(
      /not allowed/,
    );
  });

  it('should not mistake a table name that is part of a longer identifier', () => {
    expect(() =>
      assertRawQueryScoped(
        '$queryRaw',
        sql(['SELECT * FROM platform_users_x']),
        tables,
        () => undefined,
      ),
    ).not.toThrow();
  });
});
