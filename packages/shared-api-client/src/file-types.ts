import { AdminFileTypeSchema, FileTypeOptionSchema } from '@nexlegtiq/shared-contracts';
import type {
  AdminFileType,
  CreateFileSubTypeRequest,
  CreateFileTypeRequest,
  FileTypeOption,
  UpdateFileSubTypeRequest,
  UpdateFileTypeRequest,
} from '@nexlegtiq/shared-contracts';
import type { Jurisdiction } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import type { ApiClient } from './api-client.js';

const OptionsSchema = z.array(FileTypeOptionSchema);
const AdminTypesSchema = z.array(AdminFileTypeSchema);

/** The active file types and sub-types of the office's country (D-261). */
export function fileTypesApi(client: ApiClient) {
  return {
    list: (signal?: AbortSignal): Promise<FileTypeOption[]> =>
      client.request({ method: 'GET', path: 'file-types', signal }, OptionsSchema),
  };
}

/** Platform admin: file types and sub-types per country (MVP-175). */
export function adminFileTypesApi(client: ApiClient) {
  const type = (id: string) => `admin/file-types/${encodeURIComponent(id)}`;
  return {
    list: (jurisdiction: Jurisdiction, signal?: AbortSignal): Promise<AdminFileType[]> =>
      client.request(
        { method: 'GET', path: 'admin/file-types', query: { jurisdiction }, signal },
        AdminTypesSchema,
      ),
    create: (body: CreateFileTypeRequest): Promise<AdminFileType> =>
      client.request({ method: 'POST', path: 'admin/file-types', body }, AdminFileTypeSchema),
    update: (id: string, body: UpdateFileTypeRequest): Promise<AdminFileType> =>
      client.request({ method: 'PATCH', path: type(id), body }, AdminFileTypeSchema),
    createSubType: (typeId: string, body: CreateFileSubTypeRequest): Promise<AdminFileType> =>
      client.request(
        { method: 'POST', path: `${type(typeId)}/sub-types`, body },
        AdminFileTypeSchema,
      ),
    updateSubType: (id: string, body: UpdateFileSubTypeRequest): Promise<AdminFileType> =>
      client.request(
        { method: 'PATCH', path: `admin/file-sub-types/${encodeURIComponent(id)}`, body },
        AdminFileTypeSchema,
      ),
  };
}
