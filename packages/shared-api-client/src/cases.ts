import {
  CaseListItemSchema,
  CaseSchema,
  FileClientSchema,
  FileTeamMemberSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AddFileClientRequest,
  AddTeamMemberRequest,
  Case,
  CaseListItem,
  CaseQuerySchema,
  CreateCaseSchema,
  FileClient,
  FileTeamMember,
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
    get: (id: string, signal?: AbortSignal): Promise<Case> =>
      client.request({ method: 'GET', path: path(id), signal }, CaseSchema),
    create: (body: Input<typeof CreateCaseSchema>): Promise<Case> =>
      client.request({ method: 'POST', path: 'cases', body }, CaseSchema),
    update: (id: string, body: UpdateCaseRequest): Promise<Case> =>
      client.request({ method: 'PATCH', path: path(id), body }, CaseSchema),
    remove: (id: string): Promise<void> => client.request({ method: 'DELETE', path: path(id) }),
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
