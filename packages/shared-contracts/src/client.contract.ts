import { CLIENT_TYPES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { EmailSchema, longText, PhoneSchema, plainText, searchText, sortParam } from './fields.js';

/** Editable columns of a client (domain-model.md#clients--parties, D-108). */
const clientFields = {
  clientType: z.enum(CLIENT_TYPES),
  displayName: plainText(200),
  fullName: plainText(200),
  companyName: plainText(200),
  /** Stored encrypted (D-056); returned only by `GET /clients/:id`. */
  nationalId: plainText(50),
  /** Stored encrypted (D-056, D-108); returned only by `GET /clients/:id`. */
  taxId: plainText(50),
  phone: PhoneSchema,
  email: EmailSchema,
  address: longText(500),
  industry: plainText(100),
  /** An active OFFICE_MANAGER, SENIOR_LAWYER or LAWYER of the office. */
  primaryLawyerId: z.uuid(),
};

/** `POST /clients`. A new client is active. */
export const CreateClientSchema = z.object({
  clientType: clientFields.clientType,
  displayName: clientFields.displayName,
  fullName: clientFields.fullName.optional(),
  companyName: clientFields.companyName.optional(),
  nationalId: clientFields.nationalId.optional(),
  taxId: clientFields.taxId.optional(),
  phone: clientFields.phone.optional(),
  email: clientFields.email.optional(),
  address: clientFields.address.optional(),
  industry: clientFields.industry.optional(),
  primaryLawyerId: clientFields.primaryLawyerId.optional(),
});
export type CreateClientRequest = z.infer<typeof CreateClientSchema>;

/** `PATCH /clients/:id`: any subset; `null` clears an optional field. */
export const UpdateClientSchema = z
  .object({
    clientType: clientFields.clientType,
    displayName: clientFields.displayName,
    fullName: clientFields.fullName.nullable(),
    companyName: clientFields.companyName.nullable(),
    nationalId: clientFields.nationalId.nullable(),
    taxId: clientFields.taxId.nullable(),
    phone: clientFields.phone.nullable(),
    email: clientFields.email.nullable(),
    address: clientFields.address.nullable(),
    industry: clientFields.industry.nullable(),
    primaryLawyerId: clientFields.primaryLawyerId.nullable(),
    isActive: z.boolean(),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'validation.required');
export type UpdateClientRequest = z.infer<typeof UpdateClientSchema>;

export const CLIENT_SORT_FIELDS = ['name', 'createdAt', 'openFiles'] as const;
export type ClientSortField = (typeof CLIENT_SORT_FIELDS)[number];

/** `GET /clients` query: filters, `sort=name|createdAt|openFiles[:asc|desc],…`, `page`, `limit` ≤ 100. */
export const ClientQuerySchema = z.object({
  /** Part of the display, full or company name or phone (case-insensitive; every column has a trigram index). */
  search: searchText(100).optional(),
  clientType: z.enum(CLIENT_TYPES).optional(),
  isActive: z.stringbool().optional(),
  sort: sortParam(CLIENT_SORT_FIELDS).default([{ field: 'name', direction: 'asc' }]),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ClientQuery = z.infer<typeof ClientQuerySchema>;

/** A row of `GET /clients`. `openFiles` counts the office's live OPEN or SUSPENDED files of the client. */
export const ClientListItemSchema = z.object({
  id: z.uuid(),
  clientType: z.enum(CLIENT_TYPES),
  displayName: z.string(),
  fullName: z.string().nullable(),
  companyName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  isActive: z.boolean(),
  primaryLawyer: z.object({ id: z.uuid(), fullName: z.string() }).nullable(),
  openFiles: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ClientListItem = z.infer<typeof ClientListItemSchema>;

/** `POST /clients/:id/contacts`. The first contact of a client is its primary whatever `isPrimary` says. */
export const CreateContactPersonSchema = z.object({
  fullName: plainText(200),
  position: plainText(100).optional(),
  email: EmailSchema.optional(),
  phone: PhoneSchema.optional(),
  /** `true` makes this the primary contact (the previous one stops being primary). */
  isPrimary: z.boolean().default(false),
});
export type CreateContactPersonRequest = z.infer<typeof CreateContactPersonSchema>;

/**
 * `PATCH /clients/:id/contacts/:contactId`. `isPrimary` can only be set to `true` (promote): a client with contacts
 * always has exactly one primary, so the way to change it is to promote another contact.
 */
export const UpdateContactPersonSchema = z
  .object({
    fullName: plainText(200),
    position: plainText(100).nullable(),
    email: EmailSchema.nullable(),
    phone: PhoneSchema.nullable(),
    isPrimary: z.literal(true, 'validation.primaryContact'),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'validation.required');
export type UpdateContactPersonRequest = z.infer<typeof UpdateContactPersonSchema>;

export const ContactPersonSchema = z.object({
  id: z.uuid(),
  fullName: z.string(),
  position: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  isPrimary: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ContactPerson = z.infer<typeof ContactPersonSchema>;

/**
 * `GET /clients/:id` (and the answer of create/update): the client with its decrypted ids, contacts (primary first)
 * and file counts. `closedFiles` counts CLOSED and ARCHIVED files. Invoice totals join with the billing story.
 */
export const ClientSchema = ClientListItemSchema.extend({
  nationalId: z.string().nullable(),
  taxId: z.string().nullable(),
  address: z.string().nullable(),
  industry: z.string().nullable(),
  closedFiles: z.number().int(),
  contacts: z.array(ContactPersonSchema),
});
export type Client = z.infer<typeof ClientSchema>;
