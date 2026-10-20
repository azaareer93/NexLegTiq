import { officesApi } from '@nexlegtiq/shared-api-client';
import type {
  UpdateOfficeProfileRequest,
  UpdateOfficeSettingsRequest,
} from '@nexlegtiq/shared-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient, useSession } from '../../auth';

const offices = officesApi(apiClient);
export const profileKey = ['office', 'profile'] as const;
export const settingsKey = ['office', 'settings'] as const;

/** `GET /offices/me` (D-125). */
export const useOfficeProfile = () =>
  useQuery({ queryKey: profileKey, queryFn: ({ signal }) => offices.profile(signal) });

/** `GET /offices/me/settings` (D-125). */
export const useOfficeSettings = () =>
  useQuery({ queryKey: settingsKey, queryFn: ({ signal }) => offices.settings(signal) });

/** `PATCH /offices/me`; a new name shows in the header at once. */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateOfficeProfileRequest) => offices.updateProfile(body),
    onSuccess: (profile) => {
      queryClient.setQueryData(profileKey, profile);
      const { user } = useSession.getState();
      if (user) useSession.setState({ user: { ...user, officeName: profile.name } });
    },
  });
}

/** `PATCH /offices/me/settings`; a new idle timeout applies to this tab at once (others at their next refresh). */
export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateOfficeSettingsRequest) => offices.updateSettings(body),
    onSuccess: (settings) => {
      queryClient.setQueryData(settingsKey, settings);
      useSession.setState({ idleMinutes: settings.sessionIdleMinutes });
    },
  });
}
