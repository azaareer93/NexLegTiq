import { profileApi, usersApi } from '@nexlegtiq/shared-api-client';
import type {
  ChangePasswordRequest,
  Profile,
  UpdateNotificationPreferencesRequest,
  UpdateProfileRequest,
} from '@nexlegtiq/shared-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient, useSession } from '../../auth';

const profile = profileApi(apiClient);
const users = usersApi(apiClient);

export const profileKeys = {
  profile: ['profile', 'me'] as const,
  preferences: ['profile', 'notification-preferences'] as const,
};

/** The session follows a saved profile at once: header name, language and digits (D-146). */
function adopt(saved: Profile): void {
  const { user } = useSession.getState();
  if (!user) return;
  useSession.setState({
    user: {
      ...user,
      fullName: saved.fullName,
      uiLanguage: saved.uiLanguage,
      digitStyle: saved.digitStyle,
    },
  });
}

export const useProfile = () =>
  useQuery({ queryKey: profileKeys.profile, queryFn: ({ signal }) => profile.get(signal) });

function useProfileWrite<A>(write: (args: A) => Promise<Profile>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: (saved) => {
      queryClient.setQueryData(profileKeys.profile, saved);
      adopt(saved);
    },
  });
}

export const useUpdateProfile = () =>
  useProfileWrite((body: UpdateProfileRequest) => profile.update(body));

export const useUploadAvatar = () =>
  useProfileWrite(({ image, filename }: { image: Blob; filename: string }) =>
    profile.uploadAvatar(image, filename),
  );

export const useRemoveAvatar = () => useProfileWrite(() => profile.removeAvatar());

/** Language picked in the account menu, saved to the profile so it survives a reload (D-087 `onLocaleChange`). */
export function saveLanguage(uiLanguage: 'AR' | 'EN'): Promise<void> {
  return profile.update({ uiLanguage }).then(adopt);
}

export const useNotificationPreferences = () =>
  useQuery({
    queryKey: profileKeys.preferences,
    queryFn: ({ signal }) => profile.notificationPreferences(signal),
  });

export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateNotificationPreferencesRequest) =>
      profile.updateNotificationPreferences(body),
    onSuccess: (saved) => queryClient.setQueryData(profileKeys.preferences, saved),
  });
}

/** `POST /users/me/password`: other sessions end, this one stays (D-086). Nothing is kept in the mutation cache. */
export const useChangePassword = () =>
  useMutation({
    mutationFn: (body: ChangePasswordRequest) => users.changePassword(body),
    gcTime: 0,
  });
