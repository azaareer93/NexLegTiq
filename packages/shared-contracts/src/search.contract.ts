import { CLIENT_TYPES, FILE_STATUSES, TASK_STATUSES } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { searchText } from './fields.js';

export const SEARCH_TYPES = ['cases', 'clients', 'parties', 'documents', 'tasks'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** `GET /search` (D-167): at least 2 characters; `limit` is per group. */
export const SearchQuerySchema = z.object({
  q: searchText(200).pipe(z.string().min(2, 'validation.tooShort')),
  type: z.enum(['all', ...SEARCH_TYPES]).default('all'),
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

const FileRefSchema = z.object({ id: z.uuid(), fileNumber: z.string(), title: z.string() });

/** A piece of a document snippet; `match` marks the words the query found (rendered as text, never HTML). */
export const SnippetPartSchema = z.object({ text: z.string(), match: z.boolean() });
export type SnippetPart = z.infer<typeof SnippetPartSchema>;

export const SearchResultsSchema = z.object({
  cases: z.object({
    items: z.array(FileRefSchema.extend({ status: z.enum(FILE_STATUSES) })),
    hasMore: z.boolean(),
  }),
  clients: z.object({
    items: z.array(
      z.object({ id: z.uuid(), displayName: z.string(), clientType: z.enum(CLIENT_TYPES) }),
    ),
    hasMore: z.boolean(),
  }),
  parties: z.object({
    items: z.array(z.object({ id: z.uuid(), name: z.string(), isIndividual: z.boolean() })),
    hasMore: z.boolean(),
  }),
  documents: z.object({
    items: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        file: FileRefSchema,
        snippet: z.array(SnippetPartSchema),
      }),
    ),
    hasMore: z.boolean(),
  }),
  tasks: z.object({
    items: z.array(
      z.object({
        id: z.uuid(),
        title: z.string(),
        status: z.enum(TASK_STATUSES),
        dueDate: z.iso.date().nullable(),
        file: FileRefSchema.nullable(),
      }),
    ),
    hasMore: z.boolean(),
  }),
});
export type SearchResults = z.infer<typeof SearchResultsSchema>;
