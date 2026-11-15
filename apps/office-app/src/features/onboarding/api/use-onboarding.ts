import { profileApi } from '@nexlegtiq/shared-api-client';
import type { OnboardingState } from '@nexlegtiq/shared-contracts';
import { ONBOARDING_STEPS } from '@nexlegtiq/shared-types';
import type { AccountType, OnboardingStep } from '@nexlegtiq/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient } from '../../auth';

const profile = profileApi(apiClient);

export const onboardingKey = ['onboarding'] as const;

export const useOnboarding = (enabled = true) =>
  useQuery({
    queryKey: onboardingKey,
    queryFn: ({ signal }) => profile.onboarding(signal),
    enabled,
    staleTime: 60_000,
  });

/** Saves the progress on the server (it resumes on any device) and keeps the cache in step. */
export function useSaveOnboarding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (state: OnboardingState) => profile.saveOnboarding(state),
    onSuccess: (answer) => queryClient.setQueryData(onboardingKey, answer),
  });
}

/**
 * The steps of a persona (D-181): a solo practice has no team to invite; a firm invites its team before the office
 * setup; any other office follows the default order.
 */
export function stepsFor(accountType: AccountType | undefined): OnboardingStep[] {
  if (accountType === 'SOLO') return ONBOARDING_STEPS.filter((s) => s !== 'INVITE');
  if (accountType === 'FIRM') {
    return ['ACCOUNT', 'INVITE', 'OFFICE', 'TOUR', 'CASE', 'HEARING', 'DOCUMENT', 'DONE'];
  }
  return [...ONBOARDING_STEPS];
}

/** The state after leaving `from` for `to`; `finished` marks `from` done (Next), a skip leaves it as it was. */
export function advance(
  state: OnboardingState,
  from: OnboardingStep,
  to: OnboardingStep,
  finished: boolean,
): OnboardingState {
  const done = finished && !state.done.includes(from) ? [...state.done, from] : state.done;
  return { status: 'ACTIVE', step: to, done };
}
