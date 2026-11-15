import {
  AdminAuditExportQuerySchema,
  AdminAuditQuerySchema,
  AdminUsageQuerySchema,
} from './admin-usage.contract.js';

describe('platform usage contracts (D-183)', () => {
  it('should bound the usage range and the platform audit filters', () => {
    expect(AdminUsageQuerySchema.parse({})).toEqual({ days: 30 });
    expect(AdminUsageQuerySchema.safeParse({ days: '3' }).success).toBe(false);
    expect(AdminAuditQuerySchema.parse({ action: 'OFFICE_SUSPENDED' })).toMatchObject({
      limit: 50,
    });
    expect(AdminAuditQuerySchema.safeParse({ from: '2026-11-10', to: '2026-11-01' }).success).toBe(
      false,
    );
    expect(AdminAuditQuerySchema.safeParse({ from: '2025-01-01', to: '2026-11-01' }).success).toBe(
      false,
    );
    expect(
      AdminAuditExportQuerySchema.safeParse({ from: '2026-11-01', to: '2026-11-10' }).success,
    ).toBe(true);
  });
});
