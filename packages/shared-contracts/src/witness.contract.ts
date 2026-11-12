import { z } from 'zod';

import { clearable, EmailSchema, longText, PhoneSchema, plainText } from './fields.js';

/** Calendar date `YYYY-MM-DD` (D-092). The server also refuses a date after today in the office's zone. */
const DateOnlySchema = z.iso.date();

const TextSchema = longText(20_000).pipe(z.string().min(1, 'validation.required'));

/**
 * `POST /cases/:id/witnesses` (D-163). Contact details are plain text (not identifiers, D-056). Witnesses are internal
 * to the office: never shown on the client portal.
 */
export const CreateWitnessSchema = z.object({
  fullName: plainText(200),
  isExpert: z.boolean().default(false),
  expertiseArea: plainText(200).optional(),
  phone: PhoneSchema.optional(),
  email: EmailSchema.optional(),
  address: longText(500).optional(),
  notes: longText(2000).optional(),
});
export type CreateWitnessRequest = z.input<typeof CreateWitnessSchema>;

/** `PATCH /cases/:id/witnesses/:witnessId`: only the fields sent change; `null` or `''` clears an optional one. */
export const UpdateWitnessSchema = z
  .object({
    fullName: plainText(200),
    isExpert: z.boolean(),
    expertiseArea: clearable(plainText(200)),
    phone: clearable(PhoneSchema),
    email: clearable(EmailSchema),
    address: clearable(longText(500)),
    notes: clearable(longText(2000)),
  })
  .partial();
export type UpdateWitnessRequest = z.infer<typeof UpdateWitnessSchema>;

export const WitnessSchema = z.object({
  id: z.uuid(),
  fileId: z.uuid(),
  fullName: z.string(),
  isExpert: z.boolean(),
  expertiseArea: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
  statementCount: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Witness = z.infer<typeof WitnessSchema>;

/**
 * `POST /witnesses/:id/statements` (D-163). `sessionId` must be a hearing of the same file, `recordedById` an active
 * colleague who sees it (default: the caller). The text is plain text, shown as written.
 */
export const CreateWitnessStatementSchema = z.object({
  statementDate: DateOnlySchema,
  text: TextSchema,
  sessionId: z.uuid().optional(),
  recordedById: z.uuid().optional(),
  isUnderOath: z.boolean().default(false),
});
export type CreateWitnessStatementRequest = z.input<typeof CreateWitnessStatementSchema>;

export const UpdateWitnessStatementSchema = z
  .object({
    statementDate: DateOnlySchema,
    text: TextSchema,
    sessionId: z.uuid().nullable(),
    recordedById: z.uuid(),
    isUnderOath: z.boolean(),
  })
  .partial();
export type UpdateWitnessStatementRequest = z.infer<typeof UpdateWitnessStatementSchema>;

export const WitnessStatementSchema = z.object({
  id: z.uuid(),
  witnessId: z.uuid(),
  statementDate: DateOnlySchema,
  text: z.string(),
  isUnderOath: z.boolean(),
  recordedBy: z.object({ id: z.uuid(), fullName: z.string() }),
  session: z.object({ id: z.uuid(), startsAt: z.iso.datetime() }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WitnessStatement = z.infer<typeof WitnessStatementSchema>;
