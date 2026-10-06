import {
  BarChartOutlined,
  CalendarOutlined,
  CheckSquareOutlined,
  DashboardOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { Permission } from '@nexlegtiq/shared-types';
import { useCan } from '@nexlegtiq/shared-ui';
import type { ReactNode } from 'react';

export type NavKey = 'dashboard' | 'cases' | 'clients' | 'calendar' | 'tasks' | 'documents' | 'reports' | 'team' | 'settings';

export interface NavItem {
  readonly key: NavKey;
  readonly path: string;
  readonly icon: ReactNode;
  /** Needed to see the item (D-091); the page itself checks the same permission. */
  readonly perform: Permission;
}

/**
 * The main menu (frontend.md#shell) and who sees what (D-091). Every role holds `view:assigned:cases`, so the items behind it
 * are everyone's; Clients needs `manage:clients` (not trainees or external collaborators); Reports, Team and Settings follow
 * the matrix (OM/SL/A, OM, OM).
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'dashboard', path: '/', icon: <DashboardOutlined />, perform: 'view:assigned:cases' },
  { key: 'cases', path: '/cases', icon: <FolderOpenOutlined />, perform: 'view:assigned:cases' },
  { key: 'clients', path: '/clients', icon: <UserOutlined />, perform: 'manage:clients' },
  { key: 'calendar', path: '/calendar', icon: <CalendarOutlined />, perform: 'view:assigned:cases' },
  { key: 'tasks', path: '/tasks', icon: <CheckSquareOutlined />, perform: 'view:assigned:cases' },
  { key: 'documents', path: '/documents', icon: <FileTextOutlined />, perform: 'view:assigned:cases' },
  { key: 'reports', path: '/reports', icon: <BarChartOutlined />, perform: 'view:reports' },
  { key: 'team', path: '/team', icon: <TeamOutlined />, perform: 'manage:users' },
  { key: 'settings', path: '/settings', icon: <SettingOutlined />, perform: 'manage:office' },
];

/** The items of the bottom bar on phones; the rest is under "Menu". */
export const PRIMARY_KEYS: readonly NavKey[] = ['dashboard', 'cases', 'calendar', 'tasks'];

/** The menu items the signed-in user may see (`useCan` per distinct permission: hooks in a fixed order). */
export function useNavItems(): readonly NavItem[] {
  const allowed: Record<Permission, boolean> = {
    'view:assigned:cases': useCan('view:assigned:cases'),
    'manage:clients': useCan('manage:clients'),
    'view:reports': useCan('view:reports'),
    'manage:users': useCan('manage:users'),
    'manage:office': useCan('manage:office'),
  } as Record<Permission, boolean>;
  return NAV_ITEMS.filter((item) => allowed[item.perform]);
}

/** The menu key of a path (`/cases/123` → `cases`). */
export function navKeyOf(pathname: string): NavKey | undefined {
  const segment = pathname.split('/')[1] ?? '';
  return segment === '' ? 'dashboard' : NAV_ITEMS.find((item) => item.path === `/${segment}`)?.key;
}
