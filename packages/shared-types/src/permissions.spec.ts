import {
  conditionFor,
  hasAllPermissions,
  isRole,
  matchedPermissions,
  PERMISSIONS,
  permissionsFor,
  ROLE_PERMISSIONS,
  ROLES,
} from './permissions.js';
import type { Permission, Role } from './permissions.js';

/**
 * The matrix of docs/context/auth-rbac.md, transcribed independently of permissions.ts. Changing either one without
 * the other fails this test — that is the review gate for RBAC changes (MVP-38 test notes).
 * Columns: OM SL L P A T X ('c' = conditional, see PERMISSION_CONDITIONS).
 */
const MATRIX: Readonly<Record<Permission, string>> = {
  'view:all:cases': '✓✓··✓··',
  'view:assigned:cases': '✓✓✓✓✓✓✓',
  'create:case': '✓✓✓✓···',
  'edit:assigned:case': '✓✓✓✓···',
  'edit:any:case': '✓✓·····',
  'close:case': '✓✓c····',
  'reopen:case': '✓✓c····',
  'delete:case': '✓✓·····',
  'manage:clients': '✓✓✓✓✓··',
  'upload:document': '✓✓✓✓·✓✓',
  'delete:document': '✓✓✓····',
  'share:document': '✓✓✓····',
  'create:session': '✓✓✓····',
  'edit:session': '✓✓✓····',
  'create:task': '✓✓✓✓···',
  'assign:task': '✓✓✓✓···',
  'complete:task': '✓✓✓✓·✓c',
  'log:time': '✓✓✓✓·✓·',
  'view:all:invoices': '✓···✓··',
  'view:assigned:invoices': '✓✓✓✓✓··',
  'generate:invoice': '✓✓✓·✓··',
  'mark:invoice:paid': '✓✓✓·✓··',
  'use:ai': '✓✓✓✓·✓·',
  'view:audit': '✓···✓··',
  'view:reports': '✓✓··✓··',
  'manage:users': '✓······',
  'manage:office': '✓······',
  'manage:subscription': '✓······',
  'export:office': '✓······',
  'manage:portal-access': '✓✓✓····',
};

const COLUMNS: readonly Role[] = ['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER', 'PARALEGAL', 'ADMIN', 'TRAINEE', 'EXTERNAL_COLLABORATOR'];

const cells = PERMISSIONS.flatMap((permission) =>
  COLUMNS.map((role, column) => [role, permission, [...(MATRIX[permission] ?? '')][column]] as const),
);

describe('permission matrix', () => {
  it('should list every permission and role exactly once', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...PERMISSIONS].sort());
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    expect([...ROLES].sort()).toEqual([...COLUMNS].sort());
  });

  it.each(cells)('%s × %s = %s', (role, permission, cell) => {
    expect(ROLE_PERMISSIONS[role].includes(permission)).toBe(cell !== '·');
    expect(conditionFor(role, permission)).toBe(
      cell === 'c' ? (permission === 'complete:task' ? 'OWN' : 'RESPONSIBLE_LAWYER') : undefined,
    );
  });
});

describe('permission helpers', () => {
  it('should resolve a role to its permissions', () => {
    expect(permissionsFor('OFFICE_MANAGER')).toHaveLength(PERMISSIONS.length);
    expect(permissionsFor('TRAINEE')).toContain('use:ai');
  });

  it('should require every permission for ALL and report the matched ones for ANY', () => {
    const held = permissionsFor('LAWYER');
    expect(hasAllPermissions(held, ['create:case', 'use:ai'])).toBe(true);
    expect(hasAllPermissions(held, ['create:case', 'view:audit'])).toBe(false);
    expect(matchedPermissions(held, ['view:all:cases', 'view:assigned:cases'])).toEqual(['view:assigned:cases']);
    expect(matchedPermissions(permissionsFor('TRAINEE'), ['view:all:invoices', 'view:assigned:invoices'])).toEqual([]);
  });

  it('should recognise roles', () => {
    expect(isRole('LAWYER')).toBe(true);
    expect(isRole('PLATFORM_ADMIN')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});
