import { z } from 'zod';

import { longText } from './fields.js';

const BodySchema = longText(10_000).pipe(z.string().min(1, 'validation.required'));

/** `POST /cases/:id/notes` (D-154). The body is plain text: shown as written, never rendered as HTML. */
export const CreateNoteSchema = z.object({
  body: BodySchema,
  isConfidential: z.boolean().default(false),
  pinned: z.boolean().default(false),
});
export type CreateNoteRequest = z.input<typeof CreateNoteSchema>;

export const UpdateNoteSchema = z
  .object({ body: BodySchema, isConfidential: z.boolean(), pinned: z.boolean() })
  .partial();
export type UpdateNoteRequest = z.infer<typeof UpdateNoteSchema>;

/** A note of a file; `canEdit` says whether the caller may change it (its author, or OM/SL). */
export const NoteSchema = z.object({
  id: z.uuid(),
  body: z.string(),
  isConfidential: z.boolean(),
  pinned: z.boolean(),
  author: z.object({ id: z.uuid(), fullName: z.string() }),
  canEdit: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Note = z.infer<typeof NoteSchema>;
