/** The setup wizard's steps, in their default order (MVP-108, D-181). Labels: `onboarding.steps.<VALUE>`. */
export const ONBOARDING_STEPS = [
  'ACCOUNT',
  'OFFICE',
  'INVITE',
  'TOUR',
  'CASE',
  'HEARING',
  'DOCUMENT',
  'DONE',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Whether the wizard is still offered: ACTIVE (resumes), DISMISSED (by the user), COMPLETED. */
export const ONBOARDING_STATUSES = ['ACTIVE', 'DISMISSED', 'COMPLETED'] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];
