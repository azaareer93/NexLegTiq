import type { Permission } from '@nexlegtiq/shared-types';
import { useCan } from '@nexlegtiq/shared-ui';
import type { ReactNode } from 'react';
import { Outlet } from 'react-router';

import { ForbiddenPage } from './status-pages';

export interface RequirePermissionProps {
  readonly perform: Permission;
  readonly children?: ReactNode;
}

/**
 * A page the role may not open shows the 403 page. A courtesy, not security: the API checks every call again (D-051), and a
 * route loader added later must check the permission itself, as loaders run before this renders (D-091).
 */
export function RequirePermission({ perform, children }: RequirePermissionProps): ReactNode {
  const allowed = useCan(perform);
  if (!allowed) {
    return <ForbiddenPage />;
  }
  return children ?? <Outlet />;
}
