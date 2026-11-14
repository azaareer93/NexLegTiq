/**
 * Events of a file's timeline (D-039, D-150). Mirrors the Prisma enum; labels `enums.timelineEventType.<VALUE>` (the type
 * filter), sentences `timeline.event.<VALUE>` with the event's payload as params.
 */
export const TIMELINE_EVENT_TYPES = [
  'FILE_OPENED',
  'FILE_CLOSED',
  'FILE_REOPENED',
  'FILE_REASSIGNED',
  'SESSION_CREATED',
  'SESSION_UPDATED',
  'DOCUMENT_UPLOADED',
  'DOCUMENT_SHARED',
  'TASK_COMPLETED',
  'PARTY_ADDED',
  'CLIENT_ADDED',
  'CLIENT_REMOVED',
  'TEAM_MEMBER_ADDED',
  'TEAM_MEMBER_REMOVED',
  'WITNESS_STATEMENT_ADDED',
  'SUMMARY_GENERATED',
  'INVOICE_SENT',
  'INVOICE_PAID',
  'RETAINER_DEPOSITED',
] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

/**
 * The event types a client may see on the portal's public timeline (D-003, D-150): the file's milestones, its hearings,
 * documents shared with them and their invoices — never team changes, internal documents, tasks, parties or AI output.
 */
export const PORTAL_TIMELINE_EVENT_TYPES: ReadonlySet<TimelineEventType> = new Set([
  'FILE_OPENED',
  'FILE_CLOSED',
  'FILE_REOPENED',
  'SESSION_CREATED',
  'SESSION_UPDATED',
  'DOCUMENT_SHARED',
  'INVOICE_SENT',
  'INVOICE_PAID',
]);
