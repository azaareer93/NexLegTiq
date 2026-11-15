/** What an audit row records (D-019). Mirrors the Prisma enum; labels: `enums.auditAction.<VALUE>`. */
export const AUDIT_ACTIONS = [
  'CREATE',
  'UPDATE',
  'DELETE',
  'VIEW',
  'DOWNLOAD',
  'SHARE',
  'LOGIN',
  'LOGOUT',
  'EXPORT',
  'PERMISSION_DENIED',
  'SECURITY',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
