import {
  NoteSchema,
  CaseListItemSchema,
  CaseSchema,
  FileClientSchema,
  FileTeamMemberSchema,
  TimelinePageSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  CreateNoteRequest,
  Note,
  UpdateNoteRequest,
  CloseCaseRequest,
  ReassignCaseRequest,
  AddFileClientRequest,
  AddTeamMemberRequest,
  Case,
  CaseListItem,
  CaseQuerySchema,
  CreateCaseSchema,
  FileClient,
  FileTeamMember,
  TimelinePage,
  UpdateCaseRequest,
} from '@nexlegtiq/shared-contracts';
import type { z } from 'zod';

import type { ApiClient, Page } from './api-client.js';

type Input<T extends z.ZodType> = z.input<T>;

/**
 * `GET /cases` parameters as they travel in the query string (`CaseQuerySchema` input): `fileType` may list several types
 * (`LITIGATION,CRIMINAL`), `sort` is `field:dir,…`.
 */
export type CaseListParams = Partial<Record<keyof z.input<typeof CaseQuerySchema>, string>>;

/** Legal files (W6, D-096). Create joins with the quick-create form. */
export function casesApi(client: ApiClient) {
  const path = (id: string) => `cases/${encodeURIComponent(id)}`;
  const member = (id: string, kind: 'clients' | 'team', memberId: string) =>
    `${path(id)}/${kind}/${encodeURIComponent(memberId)}`;
  return {
    list: (query: CaseListParams, signal?: AbortSignal): Promise<Page<CaseListItem>> =>
      client.requestPage({ method: 'GET', path: 'cases', query, signal }, CaseListItemSchema),
    /** The file's events, newest first (D-150); `cursor` is the previous page's `nextCursor`. */
    timeline: (
      id: string,
      query: { readonly cursor?: string; readonly types?: string; readonly limit?: number },
      signal?: AbortSignal,
    ): Promise<TimelinePage> =>
      client.request(
        { method: 'GET', path: `${path(id)}/timeline`, query: { ...query }, signal },
        TimelinePageSchema,
      ),
    get: (id: string, signal?: AbortSignal): Promise<Case> =>
      client.request({ method: 'GET', path: path(id), signal }, CaseSchema),
    create: (body: Input<typeof CreateCaseSchema>): Promise<Case> =>
      client.request({ method: 'POST', path: 'cases', body }, CaseSchema),
    update: (id: string, body: UpdateCaseRequest): Promise<Case> =>
      client.request({ method: 'PATCH', path: path(id), body }, CaseSchema),
    remove: (id: string): Promise<void> => client.request({ method: 'DELETE', path: path(id) }),
    /** A file's internal notes (D-154). */
    notes: (id: string, signal?: AbortSignal): Promise<Note[]> =>
      client.request({ method: 'GET', path: `${path(id)}/notes`, signal }, NoteSchema.array()),
    addNote: (id: string, body: CreateNoteRequest): Promise<Note> =>
      client.request({ method: 'POST', path: `${path(id)}/notes`, body }, NoteSchema),
    updateNote: (id: string, noteId: string, body: UpdateNoteRequest): Promise<Note> =>
      client.request({ method: 'PATCH', path: `${path(id)}/notes/${noteId}`, body }, NoteSchema),
    removeNote: (id: string, noteId: string): Promise<void> =>
      client.request({ method: 'DELETE', path: `${path(id)}/notes/${noteId}` }),
    /** The file's lifecycle (D-153): 204 each; the caller refetches the file. */
    close: (id: string, body: CloseCaseRequest): Promise<void> =>
      client.request({ method: 'POST', path: `${path(id)}/close`, body }),
    reopen: (id: string): Promise<void> =>
      client.request({ method: 'POST', path: `${path(id)}/reopen` }),
    archive: (id: string): Promise<void> =>
      client.request({ method: 'POST', path: `${path(id)}/archive` }),
    reassign: (id: string, body: ReassignCaseRequest): Promise<FileTeamMember[]> =>
      client.request(
        { method: 'POST', path: `${path(id)}/reassign`, body },
        FileTeamMemberSchema.array(),
      ),
    /** A file's clients and team (D-140); each change answers with the new list. */
    addClient: (id: string, body: AddFileClientRequest): Promise<FileClient[]> =>
      client.request(
        { method: 'POST', path: `${path(id)}/clients`, body },
        FileClientSchema.array(),
      ),
    makePrimaryClient: (id: string, clientId: string): Promise<FileClient[]> =>
      client.request(
        { method: 'PATCH', path: member(id, 'clients', clientId), body: { isPrimary: true } },
        FileClientSchema.array(),
      ),
    removeClient: (id: string, clientId: string): Promise<void> =>
      client.request({ method: 'DELETE', path: member(id, 'clients', clientId) }),
    addTeamMember: (id: string, body: AddTeamMemberRequest): Promise<FileTeamMember[]> =>
      client.request(
        { method: 'POST', path: `${path(id)}/team`, body },
        FileTeamMemberSchema.array(),
      ),
    changeTeamRole: (
      id: string,
      userId: string,
      role: FileTeamMember['role'],
    ): Promise<FileTeamMember[]> =>
      client.request(
        { method: 'PATCH', path: member(id, 'team', userId), body: { role } },
        FileTeamMemberSchema.array(),
      ),
    removeTeamMember: (id: string, userId: string): Promise<void> =>
      client.request({ method: 'DELETE', path: member(id, 'team', userId) }),
  };
}
