import type { RouteObject } from 'react-router';

/** `/settings/audit` (D-180), inside its own `view:audit` guard. */
export const auditRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./pages/AuditPage')).AuditPage }),
  },
];
