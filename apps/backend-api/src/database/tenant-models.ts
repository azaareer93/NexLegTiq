import type { Prisma } from '../generated/prisma/client';

/**
 * Models whose rows belong to one office (non-null `officeId`). The tenant extension (MVP-37) injects and enforces
 * `officeId` for exactly these. Every new tenant model must be added here in the same PR (.claude/rules/prisma.md).
 * Office is the tenant itself; LoginAttempt, PlatformAdmin and Plan are global by design (D-079).
 */
export const TENANT_MODELS = [
  'OfficeSettings',
  'User',
  'OfficeInvitation',
  'RefreshToken',
  'PasswordResetToken',
  'EmailVerificationToken',
  'LegalAcceptance',
  'Subscription',
  'AuditLog',
  'Notification',
  // Parents before children: tests clean up in reverse order.
  'Client',
  'ContactPerson',
  'LegalFile',
  'FileClient',
  'FileTeamMember',
  'FileNumberSequence',
  'Party',
  'FileParty',
  'ConflictOfInterest',
  'CaseTimelineEvent',
  'FileNote',
  'TaskTemplate',
  'Task',
  'PublicProsecutor',
  'Session',
  'SessionReminder',
  'SessionPartyAttendance',
  'DocumentFolder',
  'Document',
  'DocumentVersion',
  'DocumentText',
] as const satisfies readonly Prisma.ModelName[];

export type TenantModel = (typeof TENANT_MODELS)[number];

/**
 * Reference models (D-037, D-115): `officeId` null = a platform row (seeded) every office reads, set = an office's own
 * row. The tenant extension lets an office read both and write only its own.
 */
export const REFERENCE_MODELS = ['Court', 'Judge'] as const satisfies readonly Prisma.ModelName[];

/**
 * To-one relations into reference models that a database trigger keeps visible to the row's office (migration
 * add_courts_judges_prosecutors, add_sessions). Includes through them are not filtered; a new one needs its trigger first (D-115).
 */
export const TRUSTED_REFERENCE_RELATIONS = [
  'LegalFile.court',
  'LegalFile.judge',
  'Judge.court',
  // Trigger of migration add_sessions.
  'Session.court',
  'Session.judge',
];
