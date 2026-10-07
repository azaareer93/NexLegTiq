import { permissionsFor } from '@nexlegtiq/shared-types';
import { render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { Can, PermissionsProvider, useCan } from './Can';

const asTrainee = ({ children }: { children: ReactNode }): React.JSX.Element => (
  <PermissionsProvider permissions={permissionsFor('TRAINEE')}>{children}</PermissionsProvider>
);

describe('useCan', () => {
  it('should reflect the provided permissions', () => {
    expect(renderHook(() => useCan('use:ai'), { wrapper: asTrainee }).result.current).toBe(true);
    expect(renderHook(() => useCan('view:audit'), { wrapper: asTrainee }).result.current).toBe(
      false,
    );
  });

  it('should deny everything outside a provider', () => {
    expect(renderHook(() => useCan('view:assigned:cases')).result.current).toBe(false);
  });
});

describe('Can', () => {
  it('should render children when the permission is held and the fallback otherwise', () => {
    render(
      <PermissionsProvider permissions={permissionsFor('TRAINEE')}>
        <Can perform="log:time">
          <span>log</span>
        </Can>
        <Can perform="manage:users" fallback={<span>no access</span>}>
          <span>users</span>
        </Can>
      </PermissionsProvider>,
    );

    expect(screen.getByText('log')).toBeTruthy();
    expect(screen.queryByText('users')).toBeNull();
    expect(screen.getByText('no access')).toBeTruthy();
  });
});
