import {
  AuditEntrySchema,
  AuditExportQuerySchema,
  AuditPageSchema,
  AuditQuerySchema,
} from './audit.contract.js';

const ID = '01920000-0000-7000-8000-0000000000a1';

describe('audit contracts (D-180)', () => {
  it('should default the page size, take filters and refuse a range over a year or crossing', () => {
    expect(AuditQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(
      AuditQuerySchema.safeParse({
        action: 'LOGIN',
        userId: ID,
        from: '2026-01-01',
        to: '2026-12-31',
      }).success,
    ).toBe(true);
    expect(AuditQuerySchema.safeParse({ from: '2025-01-01', to: '2026-11-15' }).success).toBe(
      false,
    );
    expect(AuditQuerySchema.safeParse({ from: '2026-11-15', to: '2026-11-01' }).success).toBe(
      false,
    );
    expect(AuditQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(AuditExportQuerySchema.parse({ to: '2026-11-15' })).toEqual({
      to: '2026-11-15',
      format: 'csv',
    });
    expect(AuditExportQuerySchema.safeParse({ format: 'pdf' }).success).toBe(false);
  });

  it('should read an entry and a page', () => {
    const entry = {
      id: ID,
      occurredAt: '2026-11-15T08:00:00.000Z',
      actor: { type: 'SYSTEM', id: null, name: null },
      action: 'UPDATE',
      entityType: 'Task',
      entityId: null,
      changes: [{ field: 'title', old: 'A', new: 'B' }],
    };
    expect(AuditEntrySchema.parse(entry)).toEqual(entry);
    expect(AuditPageSchema.parse({ items: [entry], nextCursor: null }).items).toHaveLength(1);
  });
});
