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
] as const satisfies readonly Prisma.ModelName[];

export type TenantModel = (typeof TENANT_MODELS)[number];
