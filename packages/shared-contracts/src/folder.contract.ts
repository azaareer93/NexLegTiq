import { FOLDER_SYSTEM_KEYS } from '@nexlegtiq/shared-types';
import { z } from 'zod';

import { plainText } from './fields.js';

/** Folder names: 1–100 characters, one line; unique among siblings (case- and Arabic-normalised, 409 RES-002). */
const FolderNameSchema = plainText(100);

/** `POST /cases/:id/folders` (D-119). No `parentId` = at the file's root. */
export const CreateFolderSchema = z.object({
  name: FolderNameSchema,
  parentId: z.uuid().optional(),
});
export type CreateFolderRequest = z.infer<typeof CreateFolderSchema>;

/**
 * `PATCH /cases/:id/folders/:folderId` — rename and/or move (`parentId: null` = to the root). System folders cannot be
 * changed (422 BIZ-014).
 */
export const UpdateFolderSchema = z
  .object({ name: FolderNameSchema, parentId: z.uuid().nullable() })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'validation.required');
export type UpdateFolderRequest = z.infer<typeof UpdateFolderSchema>;

/**
 * A folder of a file. A system folder has `systemKey` and `name: null`: the UI shows `enums.folderSystemKey.<KEY>`.
 * `documentCount` counts the folder's own live documents (not its subfolders').
 */
export const FolderSchema = z.object({
  id: z.uuid(),
  fileId: z.uuid(),
  parentId: z.uuid().nullable(),
  name: z.string().nullable(),
  systemKey: z.enum(FOLDER_SYSTEM_KEYS).nullable(),
  documentCount: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Folder = z.infer<typeof FolderSchema>;
