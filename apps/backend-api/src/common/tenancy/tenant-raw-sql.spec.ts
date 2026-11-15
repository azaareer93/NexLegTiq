import { assertRawQueryScoped } from './tenant-raw-sql';
import { TenantViolationError } from './tenant.errors';

const OFFICE = '01920000-0000-7000-8000-0000000000b1';
const TABLES = ['tasks', 'documents'];
const office = () => OFFICE;

describe('assertRawQueryScoped (D-018)', () => {
  it('should accept a tagged template, the array form and a plain string when scoped or tenant-free', () => {
    expect(() =>
      assertRawQueryScoped(
        '$queryRaw',
        { strings: ['SELECT 1 FROM tasks WHERE office_id = ', ''], values: [OFFICE] },
        TABLES,
        office,
      ),
    ).not.toThrow();
    expect(() =>
      assertRawQueryScoped(
        '$executeRaw',
        [['UPDATE documents SET x = 1 WHERE office_id = ', ''], OFFICE],
        TABLES,
        office,
      ),
    ).not.toThrow();
    expect(() => assertRawQueryScoped('$queryRaw', 'SELECT now()', TABLES, office)).not.toThrow();
    expect(() =>
      assertRawQueryScoped('$queryRaw', { strings: ['SELECT 1'] }, TABLES, office),
    ).not.toThrow();
    expect(() => assertRawQueryScoped('$queryRaw', ['SELECT 2'], TABLES, office)).not.toThrow();
  });

  it('should refuse the unsafe variants, escaped identifiers and a tenant table without the office', () => {
    expect(() => assertRawQueryScoped('$queryRawUnsafe', 'SELECT 1', TABLES, office)).toThrow(
      TenantViolationError,
    );
    expect(() =>
      assertRawQueryScoped('$queryRaw', 'SELECT * FROM U&"tasks"', TABLES, office),
    ).toThrow(/Unicode-escaped/);
    expect(() => assertRawQueryScoped('$queryRaw', 'SELECT * FROM tasks', TABLES, office)).toThrow(
      /must take the current officeId/,
    );
    expect(() => assertRawQueryScoped('$queryRaw', [7], TABLES, office)).not.toThrow();
  });
});
