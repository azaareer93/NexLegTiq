import {
  AddFilePartyResultSchema,
  ConflictSchema,
  FilePartySchema,
  PartySchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AddFilePartyRequest,
  AddFilePartyResult,
  Conflict,
  ConflictQuery,
  FileParty,
  Party,
  UpdateFilePartyRequest,
} from '@nexlegtiq/shared-contracts';

import type { ApiClient, Page } from './api-client.js';

/** `GET /conflicts` as the app holds it: strings, checked by the API. */
export type ConflictListParams = Partial<Record<keyof ConflictQuery, string>>;

/** The office's party registry, a file's parties and conflicts of interest (D-135). */
export function partiesApi(client: ApiClient) {
  const fileParties = (fileId: string) => `cases/${encodeURIComponent(fileId)}/parties`;
  return {
    search: (search: string, signal?: AbortSignal): Promise<Party[]> =>
      client.request(
        { method: 'GET', path: 'parties', query: { search }, signal },
        PartySchema.array(),
      ),
    forFile: (fileId: string, signal?: AbortSignal): Promise<FileParty[]> =>
      client.request({ method: 'GET', path: fileParties(fileId), signal }, FilePartySchema.array()),
    add: (fileId: string, body: AddFilePartyRequest): Promise<AddFilePartyResult> =>
      client.request({ method: 'POST', path: fileParties(fileId), body }, AddFilePartyResultSchema),
    update: (
      fileId: string,
      filePartyId: string,
      body: UpdateFilePartyRequest,
    ): Promise<AddFilePartyResult> =>
      client.request(
        {
          method: 'PATCH',
          path: `${fileParties(fileId)}/${encodeURIComponent(filePartyId)}`,
          body,
        },
        AddFilePartyResultSchema,
      ),
    remove: (fileId: string, filePartyId: string): Promise<void> =>
      client.request({
        method: 'DELETE',
        path: `${fileParties(fileId)}/${encodeURIComponent(filePartyId)}`,
      }),
    conflicts: (query: ConflictListParams, signal?: AbortSignal): Promise<Page<Conflict>> =>
      client.requestPage({ method: 'GET', path: 'conflicts', query, signal }, ConflictSchema),
    resolve: (id: string, notes: string): Promise<Conflict> =>
      client.request(
        {
          method: 'PATCH',
          path: `conflicts/${encodeURIComponent(id)}/resolve`,
          body: { notes },
        },
        ConflictSchema,
      ),
  };
}
