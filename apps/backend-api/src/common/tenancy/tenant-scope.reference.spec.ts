import { scopeArgs } from './tenant-scope';
import type { RelationMap, ScopeContext } from './tenant-scope';
import { TenantContextMissingError, TenantViolationError } from './tenant.errors';

const A = '01920000-0000-7000-8000-00000000000a';
const B = '01920000-0000-7000-8000-00000000000b';
const VISIBLE = { OR: [{ officeId: null }, { officeId: A }] };

// The courts slice of the schema: reference models Court/Judge, tenant LegalFile.
const relations: RelationMap = new Map([
  [
    'Office',
    new Map([
      ['courts', 'Court'],
      ['legalFiles', 'LegalFile'],
    ]),
  ],
  [
    'Court',
    new Map([
      ['office', 'Office'],
      ['judges', 'Judge'],
      ['legalFiles', 'LegalFile'],
    ]),
  ],
  [
    'Judge',
    new Map([
      ['office', 'Office'],
      ['court', 'Court'],
      ['legalFiles', 'LegalFile'],
    ]),
  ],
  [
    'LegalFile',
    new Map([
      ['office', 'Office'],
      ['court', 'Court'],
      ['judge', 'Judge'],
    ]),
  ],
]);

function ctx(officeId: string | null = A): ScopeContext {
  return {
    tenantModels: new Set(['LegalFile']),
    referenceModels: new Set(['Court', 'Judge']),
    toOneRelations: new Set(['Judge.court', 'LegalFile.court', 'LegalFile.judge']),
    relations,
    officeId: () => officeId ?? undefined,
  };
}

describe('scopeArgs — reference models (D-115)', () => {
  it.each(['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy'])(
    '%s should see platform rows and the office own rows only',
    (operation) => {
      expect(scopeArgs('Court', operation, { where: { id: 'c1' } }, ctx())).toEqual({
        where: { id: 'c1', AND: [VISIBLE] },
      });
    },
  );

  it('should AND the condition after the caller own AND and OR, so they cannot widen it', () => {
    const where = { OR: [{ officeId: B }, { id: 'x' }], AND: { nameAr: 'a' } };
    expect(scopeArgs('Court', 'findMany', { where }, ctx())).toEqual({
      where: { OR: where.OR, AND: [{ nameAr: 'a' }, VISIBLE] },
    });
  });

  it('should accept officeId null or the current office in where, and reject another office', () => {
    expect(scopeArgs('Court', 'findMany', { where: { officeId: null } }, ctx())).toEqual({
      where: { officeId: null, AND: [VISIBLE] },
    });
    expect(() => scopeArgs('Court', 'findMany', { where: { officeId: B } }, ctx())).toThrow(
      TenantViolationError,
    );
    expect(() =>
      scopeArgs('Court', 'findMany', { where: { officeId: { not: null } } }, ctx()),
    ).toThrow(TenantViolationError);
  });

  it('should create rows in the current office only', () => {
    expect(scopeArgs('Court', 'create', { data: { nameAr: 'م' } }, ctx())).toEqual({
      data: { nameAr: 'م', officeId: A },
    });
    for (const officeId of [null, B]) {
      expect(() => scopeArgs('Court', 'create', { data: { officeId } }, ctx())).toThrow(
        TenantViolationError,
      );
    }
  });

  it.each(['update', 'updateMany', 'delete', 'deleteMany', 'upsert'])(
    '%s should reach the office own rows only (platform rows are read-only)',
    (operation) => {
      const scoped = scopeArgs('Judge', operation, { where: { id: 'j1' }, data: {} }, ctx());
      expect(scoped['where']).toEqual({ id: 'j1', officeId: A });
    },
  );

  it('should reject moving a row to another office and relation writes into a reference model', () => {
    expect(() =>
      scopeArgs('Court', 'updateMany', { where: {}, data: { officeId: null } }, ctx()),
    ).toThrow(TenantViolationError);
    expect(() =>
      scopeArgs(
        'LegalFile',
        'update',
        { where: {}, data: { court: { connect: { id: 'c' } } } },
        ctx(),
      ),
    ).toThrow(TenantViolationError);
    expect(() =>
      scopeArgs('Judge', 'create', { data: { court: { connect: { id: 'c' } } } }, ctx()),
    ).toThrow(TenantViolationError);
  });

  it('should fail closed without an office', () => {
    expect(() => scopeArgs('Court', 'findMany', {}, ctx(null))).toThrow(TenantContextMissingError);
  });

  it('should scope a list include into a reference model (other offices judges at a platform court)', () => {
    expect(scopeArgs('Court', 'findMany', { include: { judges: true } }, ctx())).toEqual({
      where: { AND: [VISIBLE] },
      include: { judges: { where: { AND: [VISIBLE] } } },
    });
  });

  it('should leave a to-one include into a reference model alone (the triggers keep it visible)', () => {
    expect(
      scopeArgs(
        'LegalFile',
        'findFirst',
        { include: { court: true, judge: { select: { id: true } } } },
        ctx(),
      ),
    ).toEqual({
      where: { officeId: A },
      include: { court: true, judge: { select: { id: true } } },
    });
  });

  it('should scope tenant rows reached from a reference model to the office', () => {
    expect(
      scopeArgs(
        'Court',
        'findMany',
        { select: { _count: { select: { legalFiles: true } } } },
        ctx(),
      ),
    ).toEqual({
      where: { AND: [VISIBLE] },
      select: { _count: { select: { legalFiles: { where: { officeId: A } } } } },
    });
  });

  it('should scope relation filters into a reference model, `every` judging visible rows only', () => {
    expect(
      scopeArgs('Court', 'findMany', { where: { judges: { some: { fullName: 'x' } } } }, ctx()),
    ).toEqual({
      where: { judges: { some: { fullName: 'x', AND: [VISIBLE] } }, AND: [VISIBLE] },
    });
    expect(
      scopeArgs('Court', 'findMany', { where: { judges: { every: { isActive: true } } } }, ctx()),
    ).toEqual({
      where: {
        judges: { every: { OR: [{ NOT: { AND: [VISIBLE] } }, { isActive: true }] } },
        AND: [VISIBLE],
      },
    });
    expect(
      scopeArgs('LegalFile', 'findMany', { where: { court: { nameAr: 'x' } } }, ctx()),
    ).toEqual({ where: { court: { nameAr: 'x', AND: [VISIBLE] }, officeId: A } });
  });

  it('should reject ordering by a count of reference rows', () => {
    expect(() =>
      scopeArgs('Court', 'findMany', { orderBy: { judges: { _count: 'desc' } } }, ctx()),
    ).toThrow(TenantViolationError);
  });
});
