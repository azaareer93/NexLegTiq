import { DIGIT_STYLES, NOTIFICATION_CATEGORIES, ROLES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { clearable, PhoneSchema, plainText, TimeZoneSchema } from './fields.js';

/** `GET /users/me` (D-146): the caller's own profile. The avatar is a short-lived link (private storage, D-085). */
export const ProfileSchema = z.object({
  id: z.uuid(),
  fullName: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  phone: z.string().nullable(),
  uiLanguage: z.enum(['AR', 'EN']),
  /** The zone of what is addressed to the user (reminder emails); null = the office's. Screens use the office's (D-127). */
  timezone: z.string().nullable(),
  digitStyle: z.enum(DIGIT_STYLES),
  avatar: z.object({ url: z.url(), expiresIn: z.number().int().positive() }).nullable(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** `PATCH /users/me`: only what is sent changes; `null` clears phone or time zone. */
export const UpdateProfileSchema = z
  .object({
    fullName: plainText(120).pipe(z.string().min(2, 'validation.tooShort')),
    phone: clearable(PhoneSchema),
    uiLanguage: z.enum(['AR', 'EN']),
    timezone: clearable(TimeZoneSchema),
    digitStyle: z.enum(DIGIT_STYLES),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'validation.required');
export type UpdateProfileRequest = z.infer<typeof UpdateProfileSchema>;

const ChannelsSchema = z.object({ email: z.boolean(), inApp: z.boolean() });

/** `GET /notifications/preferences`: every category with its channels (on unless turned off); `email` only where one exists. */
export const NotificationPreferencesSchema = z.array(
  z.object({
    category: z.enum(NOTIFICATION_CATEGORIES),
    inApp: z.boolean(),
    /** Null when the category sends no email. */
    email: z.boolean().nullable(),
  }),
);
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

/** `PATCH /notifications/preferences`: `{HEARINGS: {email: false}}` — only what is sent changes. */
export const UpdateNotificationPreferencesSchema = z
  .partialRecord(z.enum(NOTIFICATION_CATEGORIES), ChannelsSchema.partial())
  .refine((body) => Object.keys(body).length > 0, 'validation.required');
export type UpdateNotificationPreferencesRequest = z.infer<
  typeof UpdateNotificationPreferencesSchema
>;
