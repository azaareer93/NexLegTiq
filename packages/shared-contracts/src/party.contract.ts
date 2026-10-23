import { PARTY_TYPES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { EmailSchema, longText, PhoneSchema, plainText, searchText } from './fields.js';

/** Why a party was flagged (W9, D-135): on another open file on a dispute side, or that file's client while adverse here. */
export const CONFLICT_REASONS = ['ADVERSE_ON_OTHER_FILE', 'CLIENT_ON_OTHER_FILE'] as const;
export type ConflictReason = (typeof CONFLICT_REASONS)[number];

/** A new party of the office's registry (domain-model.md#clients--parties, D-030). */
export const NewPartySchema = z
  .object({
    isIndividual: z.boolean(),
    fullName: plainText(200).optional(),
    companyName: plainText(200).optional(),
    /** Stored encrypted (D-056); findable by exact value through its blind index (D-135). */
    nationalId: plainText(50).optional(),
    /** Encrypted for an individual (D-056); findable by exact value. */
    taxId: plainText(50).optional(),
    address: longText(500).optional(),
    phone: PhoneSchema.optional(),
    email: EmailSchema.optional(),
    legalRepresentative: plainText(200).optional(),
    /** Stored encrypted (D-056). */
    notes: longText(2000).optional(),
  })
  .refine((party) => (party.isIndividual ? party.fullName : party.companyName), {
    message: 'validation.required',
    path: ['fullName'],
  });
export type NewPartyRequest = z.infer<typeof NewPartySchema>;

/** `POST /cases/:id/parties`: an existing party of the office (`partyId`) or a new one (`party`), never both. */
export const AddFilePartySchema = z
  .object({
    partyId: z.uuid().optional(),
    party: NewPartySchema.optional(),
    partyType: z.enum(PARTY_TYPES),
    roleLabel: plainText(100).optional(),
  })
  .refine((body) => (body.partyId === undefined) !== (body.party === undefined), {
    message: 'validation.partyChoice',
    path: ['partyId'],
  });
export type AddFilePartyRequest = z.infer<typeof AddFilePartySchema>;

/** `PATCH /cases/:id/parties/:filePartyId`; `roleLabel: null` clears it. */
export const UpdateFilePartySchema = z.object({
  partyType: z.enum(PARTY_TYPES).optional(),
  roleLabel: plainText(100).nullable().optional(),
});
export type UpdateFilePartyRequest = z.infer<typeof UpdateFilePartySchema>;

/** `GET /parties?search=`: name (Arabic-normalised substring), or an exact national or tax id. */
export const PartyQuerySchema = z.object({
  search: searchText(100).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type PartyQuery = z.infer<typeof PartyQuerySchema>;

/** A party of the registry, for reuse pickers: no identifiers or notes (those are read on the file). */
export const PartySchema = z.object({
  id: z.uuid(),
  isIndividual: z.boolean(),
  name: z.string(),
  fullName: z.string().nullable(),
  companyName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
});
export type Party = z.infer<typeof PartySchema>;

/** A party on a file, with the decrypted identifiers and notes for people who can open the file. */
export const FilePartySchema = z.object({
  id: z.uuid(),
  partyType: z.enum(PARTY_TYPES),
  roleLabel: z.string().nullable(),
  joinedAt: z.iso.datetime(),
  party: PartySchema.extend({
    nationalId: z.string().nullable(),
    taxId: z.string().nullable(),
    address: z.string().nullable(),
    legalRepresentative: z.string().nullable(),
    notes: z.string().nullable(),
  }),
});
export type FileParty = z.infer<typeof FilePartySchema>;

/** A file in a conflict; null when the reader may not open it (only that a conflict exists is shown, D-116 style). */
const ConflictFileSchema = z
  .object({ id: z.uuid(), fileNumber: z.string(), title: z.string() })
  .nullable();

export const ConflictSchema = z.object({
  id: z.uuid(),
  reason: z.enum(CONFLICT_REASONS),
  party: z.object({ id: z.uuid(), name: z.string() }),
  /** The file the party was added to when the conflict was found. */
  file: ConflictFileSchema,
  otherFile: ConflictFileSchema,
  detectedAt: z.iso.datetime(),
  resolved: z.boolean(),
  resolutionNotes: z.string().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type Conflict = z.infer<typeof ConflictSchema>;

/** The answer of `POST /cases/:id/parties`: the new file party and every open conflict it is involved in. */
export const AddFilePartyResultSchema = z.object({
  fileParty: FilePartySchema,
  conflicts: z.array(ConflictSchema),
});
export type AddFilePartyResult = z.infer<typeof AddFilePartyResultSchema>;

/** `GET /conflicts`. */
export const ConflictQuerySchema = z.object({
  resolved: z.enum(['true', 'false']).optional(),
  fileId: z.uuid().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ConflictQuery = z.infer<typeof ConflictQuerySchema>;

/** `PATCH /conflicts/:id/resolve`: why the office may proceed (or what it did). */
export const ResolveConflictSchema = z.object({
  notes: longText(2000).pipe(z.string().min(1, 'validation.required')),
});
export type ResolveConflictRequest = z.infer<typeof ResolveConflictSchema>;
