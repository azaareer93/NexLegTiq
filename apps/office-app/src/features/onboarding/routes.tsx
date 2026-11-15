import type { RouteObject } from 'react-router';

/** `/onboarding` (D-181), inside the `manage:office` guard: its steps set up the office. */
export const onboardingRoutes: RouteObject[] = [
  {
    index: true,
    lazy: async () => ({ Component: (await import('./pages/OnboardingPage')).OnboardingPage }),
  },
];
