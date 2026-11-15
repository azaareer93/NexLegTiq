import { auditCsv, BOM, csvCell } from './audit-csv';
import { toEntry } from './audit-log.service';

const ID = '01920000-0000-7000-8000-0000000000a1';
const row = (extra: object = {}) =>
  ({
    id: ID,
    occurredAt: new Date('2026-11-11T08:00:00.000Z'),
    userId: null,
    platformAdminId: null,
    clientUserId: null,
    action: 'UPDATE',
    entityType: 'Task',
    entityId: null,
    oldValues: null,
    newValues: null,
    user: null,
    ...extra,
  }) as never;

describe('audit CSV and entries (D-180)', () => {
  it('should quote every cell and defuse formulas', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
    expect(csvCell('-1')).toBe(`"'-1"`);
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(null)).toBe('""');
  });

  it('should name each kind of actor and list the changed fields', () => {
    expect(toEntry(row({ userId: ID, user: { fullName: 'Omar' } })).actor).toEqual({
      type: 'USER',
      id: ID,
      name: 'Omar',
    });
    expect(toEntry(row({ platformAdminId: ID })).actor.type).toBe('PLATFORM_ADMIN');
    expect(toEntry(row({ clientUserId: ID })).actor).toEqual({
      type: 'CLIENT',
      id: ID,
      name: null,
    });
    expect(toEntry(row()).actor.type).toBe('SYSTEM');
    expect(toEntry(row({ oldValues: { a: 1 }, newValues: { a: 2, b: 'x' } })).changes).toEqual([
      { field: 'a', old: 1, new: 2 },
      { field: 'b', old: null, new: 'x' },
    ]);
    expect(toEntry(row({ newValues: ['not', 'an', 'object'] })).changes).toEqual([]);
  });

  it('should write a BOM, a header and office wall-clock times', () => {
    const csv = auditCsv([toEntry(row())], 'Asia/Hebron');
    expect(csv.startsWith(`${BOM}"occurredAt"`)).toBe(true);
    expect(csv).toContain('"2026-11-11 10:00","SYSTEM","","UPDATE","Task","",""');
  });
});
