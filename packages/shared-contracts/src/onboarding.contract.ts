import { ONBOARDING_STATUSES, ONBOARDING_STEPS } from '@nexlegtiq/shared-types';
import { z } from 'zod';

/**
 * The setup wizard's progress (MVP-108, D-181), kept on the user so it resumes on any device: where it is, the steps
 * finished or skipped, and whether it is still offered.
 */
export const OnboardingStateSchema = z.object({
  status: z.enum(ONBOARDING_STATUSES),
  step: z.enum(ONBOARDING_STEPS),
  done: z
    .array(z.enum(ONBOARDING_STEPS))
    .max(ONBOARDING_STEPS.length)
    .refine((steps) => new Set(steps).size === steps.length, { message: 'validation.duplicate' }),
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

/** `GET /users/me/onboarding`: the state, or null for a user never offered the wizard (an invited colleague). */
export const OnboardingAnswerSchema = z.object({ state: OnboardingStateSchema.nullable() });
export type OnboardingAnswer = z.infer<typeof OnboardingAnswerSchema>;
