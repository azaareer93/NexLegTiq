import type { Permission } from '@nexlegtiq/shared-types';
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

const PermissionsContext = createContext<readonly Permission[]>([]);

export interface PermissionsProviderProps {
  /** The signed-in user's permissions (login response, MVP-40); empty while signed out. */
  readonly permissions: readonly Permission[];
  readonly children: ReactNode;
}

/**
 * Makes the current user's permissions available to `useCan` / `<Can>`. UI hiding only: the API enforces every
 * permission again (PermissionsGuard, D-051), so a hidden button is a convenience, not a security boundary.
 */
export function PermissionsProvider({
  permissions,
  children,
}: PermissionsProviderProps): ReactNode {
  return <PermissionsContext.Provider value={permissions}>{children}</PermissionsContext.Provider>;
}

/** True when the signed-in user holds `permission` (false outside a PermissionsProvider). */
export function useCan(permission: Permission): boolean {
  return useContext(PermissionsContext).includes(permission);
}

export interface CanProps {
  /** Shown when the user holds this permission. */
  readonly perform: Permission;
  readonly children: ReactNode;
  /** Shown otherwise (nothing by default). Pass translated content (t()), never a literal string. */
  readonly fallback?: ReactNode;
}

/** Renders `children` only for users holding `perform`, e.g. `<Can perform="create:case"><NewCaseButton /></Can>`. */
export function Can({ perform, children, fallback = null }: CanProps): ReactNode {
  return useCan(perform) ? children : fallback;
}
