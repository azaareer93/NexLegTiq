import { z } from 'zod';

/** The socket.io namespace of the office realm (architecture.md#realtime, D-129). */
export const REALTIME_NAMESPACE = '/ws';

/**
 * What the server pushes (D-129). Payloads carry **ids only**: the app refetches through the normal API, which applies
 * every access rule, so an event can never leak a document, a hearing or a confidential file's content.
 */
export const RealtimePayloadSchemas = {
  'document.processed': z.object({ documentId: z.uuid(), fileId: z.uuid() }),
  'document.summary.ready': z.object({ documentId: z.uuid(), fileId: z.uuid() }),
  'session.scheduled': z.object({ sessionId: z.uuid(), fileId: z.uuid() }),
  'session.reminder': z.object({ sessionId: z.uuid(), reminderId: z.uuid() }),
  'task.assigned': z.object({ taskId: z.uuid(), fileId: z.uuid().nullable() }),
  'task.updated': z.object({ taskId: z.uuid(), fileId: z.uuid().nullable() }),
  notification: z.object({ notificationId: z.uuid() }),
  'ai.job.completed': z.object({ jobId: z.string().min(1).max(200) }),
  'ai.job.failed': z.object({ jobId: z.string().min(1).max(200) }),
} as const;

export type RealtimeEvent = keyof typeof RealtimePayloadSchemas;
export type RealtimePayload<E extends RealtimeEvent> = z.infer<(typeof RealtimePayloadSchemas)[E]>;

export const REALTIME_EVENTS = Object.keys(RealtimePayloadSchemas) as RealtimeEvent[];
