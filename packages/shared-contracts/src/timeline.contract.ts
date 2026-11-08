import { TIMELINE_EVENT_TYPES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

/**
 * `GET /cases/:id/timeline` (D-150): newest first by cursor (api-conventions.md) — `cursor` is the previous page's
 * `nextCursor`; `types` a comma-separated list of event types.
 */
export const TimelineQuerySchema = z.object({
  cursor: z.uuid().optional(),
  types: z
    .string()
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(z.enum(TIMELINE_EVENT_TYPES)).max(TIMELINE_EVENT_TYPES.length))
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type TimelineQuery = z.infer<typeof TimelineQuerySchema>;

/** One event: the app renders `timeline.event.<eventType>` with `payload`; `actor` is null for the system. */
export const TimelineEventSchema = z.object({
  id: z.uuid(),
  eventType: z.enum(TIMELINE_EVENT_TYPES),
  sourceType: z.string().nullable(),
  sourceId: z.uuid().nullable(),
  occurredAt: z.iso.datetime(),
  actor: z.object({ id: z.uuid(), fullName: z.string() }).nullable(),
  payload: z.record(z.string(), z.unknown()),
  /** Shown on the Client Portal's public timeline (PORTAL_TIMELINE_EVENT_TYPES). */
  portalVisible: z.boolean(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const TimelinePageSchema = z.object({
  items: z.array(TimelineEventSchema),
  nextCursor: z.uuid().nullable(),
  /** Names of the colleagues and clients the events mention (payload `userId`, `fromUserId`, `toUserId`, `clientId`). */
  names: z.record(z.uuid(), z.string()),
});
export type TimelinePage = z.infer<typeof TimelinePageSchema>;
