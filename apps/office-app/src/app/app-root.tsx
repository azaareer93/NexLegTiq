import type { Locale } from '@nexlegtiq/shared-types';
import { NexProvider, PermissionsProvider } from '@nexlegtiq/shared-ui';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { queryClient, useSession } from '../features/auth';

/**
 * Providers around every page: React Query, the signed-in user's language (D-087) and permissions (D-081). Signed out,
 * the language picked on the sign-in page applies.
 */
export function AppRoot({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const user = useSession((state) => state.user);
  const userLocale: Locale | null = user ? (user.uiLanguage === 'EN' ? 'en' : 'ar') : null;
  return (
    <QueryClientProvider client={queryClient}>
      <NexProvider userLocale={userLocale}>
        <PermissionsProvider permissions={user?.permissions ?? []}>{children}</PermissionsProvider>
      </NexProvider>
    </QueryClientProvider>
  );
}
