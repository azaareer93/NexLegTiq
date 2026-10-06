import { Prisma } from '../../generated/prisma/client';
import { assertRawQueryScoped, scopeArgs } from './tenant-scope';
import type { RelationMap, ScopeContext } from './tenant-scope';
import { TenantContextMissingError, TenantViolationError } from './tenant.errors';

// Cases added by the MVP-37 review (D-080): read-only global models, relation filters, orderBy, raw SQL edge cases.
const A = '01920000-0000-7000-8000-00000000000a';
const B = '01920000-0000-7000-8000-00000000000b';

const relations: RelationMap = new Map([
  [
    'Office',
    new Map([
      ['users', 'User'],
      ['subscriptions', 'Subscription'],
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
    tenantModels: new Set(['User', 'Notification', 'Subscription']),
    relations,
    officeId: () => officeId ?? undefined,
  };
}

describe('scopeArgs — missing context and unknown shapes', () => {
  it.each(['create', 'createMany', 'upsert', 'update', 'delete', 'groupBy', 'aggregate'])(
    'should need an office for User.%s',
    (op) => {
      expect(() => scopeArgs('User', op, { where: { id: 'u1' }, data: {} }, ctx(null))).toThrow(
        TenantContextMissingError,
      );
    },
  );

  it('should need an office for Office reads and updates', () => {
    expect(() => scopeArgs('Office', 'findMany', {}, ctx(null))).toThrow(TenantContextMissingError);
    expect(() => scopeArgs('Office', 'update', { where: {}, data: {} }, ctx(null))).toThrow(
      TenantContextMissingError,
    );
  });

  it('should fail closed on an operation it does not know', () => {
    expect(() => scopeArgs('User', 'findEverything', {}, ctx())).toThrow(/not supported/);
  });

  it('should reject a createMany row that is not an object', () => {
    expect(() =>
      scopeArgs('User', 'createMany', { data: [{ email: 'e' }, 'oops'] }, ctx()),
    ).toThrow(TenantViolationError);
  });
});

describe('scopeArgs — global models and relation writes', () => {
  it.each(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'])(
    'should keep global models read-only (Plan.%s)',
    (op) => {
      expect(() => scopeArgs('Plan', op, { where: { id: 'p1' }, data: {} }, ctx())).toThrow(
        /read-only/,
      );
    },
  );

  it('should allow only connect/disconnect into a global model', () => {
    const connect = { where: { id: 's1' }, data: { plan: { connect: { id: 'p2' } } } };
    expect(scopeArgs('Subscription', 'update', connect, ctx())).toMatchObject({
      data: { plan: { connect: { id: 'p2' } } },
    });
    for (const op of ['create', 'update', 'upsert', 'connectOrCreate']) {
      const nested = { where: { id: 's1' }, data: { plan: { [op]: {} } } };
      expect(() => scopeArgs('Subscription', 'update', nested, ctx())).toThrow(
        /only connect\/disconnect/,
      );
    }
  });

  it.each(['disconnect', 'deleteMany', 'updateMany', 'createManyAndReturn'])(
    'should reject a nested %s into a tenant model',
    (op) => {
      const args = { where: { id: 'u1' }, data: { notifications: { [op]: {} } } };
      expect(() => scopeArgs('User', 'update', args, ctx())).toThrow(TenantViolationError);
    },
  );

  it('should reject relation writes from the Office root into tenant models', () => {
    const args = { where: {}, data: { users: { create: { email: 'e' } } } };
    expect(() => scopeArgs('Office', 'update', args, ctx())).toThrow(TenantViolationError);
  });
});

describe('scopeArgs — relation filters, orderBy and projections', () => {
  it('should scope some/none relation filters that cross a global model', () => {
    const where = { plan: { subscriptions: { some: { status: 'ACTIVE' }, none: { notes: 'x' } } } };
    expect(scopeArgs('Subscription', 'findMany', { where }, ctx())).toEqual({
      where: {
        officeId: A,
        plan: {
          subscriptions: {
            some: { status: 'ACTIVE', officeId: A },
            none: { notes: 'x', officeId: A },
          },
        },
      },
    });
  });

  it('should make `every` judge only the current office rows', () => {
    expect(
      scopeArgs(
        'Plan',
        'findMany',
        { where: { subscriptions: { every: { status: 'ACTIVE' } } } },
        ctx(),
      ),
    ).toEqual({
      where: { subscriptions: { every: { OR: [{ NOT: { officeId: A } }, { status: 'ACTIVE' }] } } },
    });
  });

  it('should scope relation filters inside AND/OR/NOT and reject a foreign office in them', () => {
    expect(
      scopeArgs('Plan', 'findMany', { where: { OR: [{ subscriptions: { some: {} } }] } }, ctx()),
    ).toEqual({
      where: { OR: [{ subscriptions: { some: { officeId: A } } }] },
    });
    const foreign = { where: { subscriptions: { some: { officeId: B } } } };
    expect(() => scopeArgs('Plan', 'findMany', foreign, ctx())).toThrow(TenantViolationError);
  });

  it('should reject ordering a global model by a tenant relation, but allow ordering by a global one', () => {
    expect(() =>
      scopeArgs('Plan', 'findMany', { orderBy: { subscriptions: { _count: 'desc' } } }, ctx()),
    ).toThrow(/every office/);
    expect(() =>
      scopeArgs('Subscription', 'findMany', { orderBy: [{ plan: { name: 'asc' } }] }, ctx()),
    ).not.toThrow();
  });

  it('should scope _count and select inside includes, and skip disabled relations', () => {
    const args = {
      include: { plan: { select: { _count: { select: { subscriptions: true } } } } },
      office: false,
    };
    expect(scopeArgs('Subscription', 'findMany', args, ctx())).toEqual({
      where: { officeId: A },
      include: {
        plan: { select: { _count: { select: { subscriptions: { where: { officeId: A } } } } } },
      },
      office: false,
    });
    expect(
      scopeArgs(
        'Plan',
        'findMany',
        { include: { subscriptions: false }, select: { _count: false } },
        ctx(),
      ),
    ).toEqual({
      include: { subscriptions: false },
      select: { _count: false },
    });
  });

  it('should reject a foreign office inside an include filter', () => {
    const args = { include: { subscriptions: { where: { officeId: B } } } };
    expect(() => scopeArgs('Plan', 'findMany', args, ctx())).toThrow(TenantViolationError);
  });

  it('should leave the Office root lists unfiltered (they are the current office rows)', () => {
    expect(scopeArgs('Office', 'findMany', { include: { users: true } }, ctx())).toEqual({
      where: { id: A },
      include: { users: true },
    });
  });
});

describe('assertRawQueryScoped — edge cases', () => {
  const tables = ['users', 'notifications'];

  it('should work with real Prisma.sql and Prisma.join objects', () => {
    const scoped = Prisma.sql`SELECT * FROM users WHERE office_id = ${A}`;
    expect(() => assertRawQueryScoped('$queryRaw', scoped, tables, () => A)).not.toThrow();
    const joined = Prisma.sql`SELECT * FROM users WHERE id IN (${Prisma.join([A, B])})`;
    expect(() => assertRawQueryScoped('$queryRaw', joined, tables, () => A)).not.toThrow();
    const foreign = Prisma.sql`SELECT * FROM users WHERE id IN (${Prisma.join([B])})`;
    expect(() => assertRawQueryScoped('$queryRaw', foreign, tables, () => A)).toThrow(
      TenantViolationError,
    );
  });

  it.each(['SELECT * FROM "public"."users"', 'SELECT * FROM public.users', 'SELECT * FROM USERS'])(
    'should see the tenant table in %s',
    (text) => {
      expect(() =>
        assertRawQueryScoped('$queryRaw', { strings: [text], values: [] }, tables, () => A),
      ).toThrow(TenantViolationError);
    },
  );

  it('should reject Unicode-escaped identifiers and allow non-tenant tables', () => {
    const escaped = { strings: ['SELECT * FROM U&"\\0075sers"'], values: [] };
    expect(() => assertRawQueryScoped('$queryRaw', escaped, tables, () => A)).toThrow(/Unicode/);
    const plans = { strings: ['SELECT * FROM plans'], values: [] };
    expect(() => assertRawQueryScoped('$queryRaw', plans, tables, () => undefined)).not.toThrow();
  });

  it('should pin the documented limit: the officeId only has to be among the parameters', () => {
    const misplaced = { strings: ['SELECT ', ', * FROM users'], values: [A] };
    expect(() => assertRawQueryScoped('$queryRaw', misplaced, tables, () => A)).not.toThrow();
  });
});
