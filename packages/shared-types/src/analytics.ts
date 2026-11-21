/**
 * Product analytics events (D-215): first-party, counted per office, never about a person. `APP_ACTIVE` is the
 * once-a-day activity signal retention is measured with.
 */
export const PRODUCT_EVENT_TYPES = [
  'SIGNUP_COMPLETED',
  'ONBOARDING_STEP_COMPLETED',
  'ONBOARDING_COMPLETED',
  'FIRST_CASE_CREATED',
  'HEARING_SCHEDULED',
  'DOCUMENT_UPLOADED',
  'AI_SUMMARY_GENERATED',
  'INVITE_SENT',
  'PORTAL_INVITE_SENT',
  'APP_ACTIVE',
] as const;
export type ProductEventType = (typeof PRODUCT_EVENT_TYPES)[number];
