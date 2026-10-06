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

interface NavItemShape {
  readonly key: string;
  readonly path: string;
  readonly icon: ReactNode;
  /** Needed to see the item and to open its page (D-091): the routes are built from this list. */
  readonly perform: Permission;
}

/**
 * The main menu (frontend.md#shell) and who sees what (D-091). Every role holds `view:assigned:cases`, so the items behind it
 * are everyone's; Clients needs `manage:clients` (not trainees or external collaborators); Reports, Team and Settings follow
 * the matrix (OM/SL/A, OM, OM). The routes in `app/routes.tsx` are generated from this list, so a menu item and its page can
 * never require different permissions.
 */
export const NAV_ITEMS = [
  { key: 'dashboard', path: '/', icon: <DashboardOutlined />, perform: 'view:assigned:cases' },
  { key: 'cases', path: '/cases', icon: <FolderOpenOutlined />, perform: 'view:assigned:cases' },
  { key: 'clients', path: '/clients', icon: <UserOutlined />, perform: 'manage:clients' },
  { key: 'calendar', path: '/calendar', icon: <CalendarOutlined />, perform: 'view:assigned:cases' },
  { key: 'tasks', path: '/tasks', icon: <CheckSquareOutlined />, perform: 'view:assigned:cases' },
  { key: 'documents', path: '/documents', icon: <FileTextOutlined />, perform: 'view:assigned:cases' },
  { key: 'reports', path: '/reports', icon: <BarChartOutlined />, perform: 'view:reports' },
  { key: 'team', path: '/team', icon: <TeamOutlined />, perform: 'manage:users' },
  { key: 'settings', path: '/settings', icon: <SettingOutlined />, perform: 'manage:office' },
] as const satisfies readonly NavItemShape[];

export type NavItem = (typeof NAV_ITEMS)[number];
export type NavKey = NavItem['key'];
type NavPermission = NavItem['perform'];

/** The items of the bottom bar on phones; the rest is under "Menu". */
export const PRIMARY_KEYS: readonly NavKey[] = ['dashboard', 'cases', 'calendar', 'tasks'];

/**
 * The menu items the signed-in user may see. One `useCan` per distinct permission, in a fixed order (rules of hooks); the
 * record is typed from `NAV_ITEMS`, so a new permission in the list fails to compile until it is added here.
 */
export function useNavItems(): readonly NavItem[] {
  const allowed: Record<NavPermission, boolean> = {
    'view:assigned:cases': useCan('view:assigned:cases'),
    'manage:clients': useCan('manage:clients'),
    'view:reports': useCan('view:reports'),
    'manage:users': useCan('manage:users'),
    'manage:office': useCan('manage:office'),
  };
  return NAV_ITEMS.filter((item) => allowed[item.perform]);
}

/** The menu key of a path (`/cases/123` → `cases`); `undefined` off the menu (`/profile`, unknown pages). */
export function navKeyOf(pathname: string): NavKey | undefined {
  const segment = pathname.split('/')[1] ?? '';
  return segment === '' ? 'dashboard' : NAV_ITEMS.find((item) => item.path === `/${segment}`)?.key;
}
