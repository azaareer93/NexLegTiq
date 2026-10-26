import { NotificationPreferencesSchema, ProfileSchema } from '@nexlegtiq/shared-contracts';
import type {
  NotificationPreferences,
  Profile,
  UpdateNotificationPreferencesRequest,
  UpdateProfileRequest,
} from '@nexlegtiq/shared-contracts';

import type { ApiClient } from './api-client.js';

/** The signed-in user's own profile, picture and notification preferences (D-146). */
export function profileApi(client: ApiClient) {
  return {
    get: (signal?: AbortSignal): Promise<Profile> =>
      client.request({ method: 'GET', path: 'users/me', signal }, ProfileSchema),
    /** Only the fields sent change; `null` clears phone or time zone. */
    update: (body: UpdateProfileRequest): Promise<Profile> =>
      client.request({ method: 'PATCH', path: 'users/me', body }, ProfileSchema),
    /** A PNG or JPEG of at most 2 MB (the app resizes it first). */
    uploadAvatar: (image: Blob, filename: string): Promise<Profile> => {
      const form = new FormData();
      form.append('file', image, filename);
      return client.request({ method: 'POST', path: 'users/me/avatar', body: form }, ProfileSchema);
    },
    removeAvatar: (): Promise<Profile> =>
      client.request({ method: 'DELETE', path: 'users/me/avatar' }, ProfileSchema),
    notificationPreferences: (signal?: AbortSignal): Promise<NotificationPreferences> =>
      client.request(
        { method: 'GET', path: 'notifications/preferences', signal },
        NotificationPreferencesSchema,
      ),
    updateNotificationPreferences: (
      body: UpdateNotificationPreferencesRequest,
    ): Promise<NotificationPreferences> =>
      client.request(
        { method: 'PATCH', path: 'notifications/preferences', body },
        NotificationPreferencesSchema,
      ),
  };
}
