import { randomUUID } from 'node:crypto';

import type { OfficeId } from '@nexlegtiq/shared-types';

import { TenantViolationError } from './tenant.errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_PART = /^[A-Za-z0-9._-]+$/;
const EXTENSION = /^[a-z0-9]{1,10}$/;

function assertUuid(value: string, name: string): void {
  if (!UUID.test(value)) throw new TenantViolationError(`${name} must be a UUID`);
}

/**
 * Cache keys holding tenant data always start with `o:{officeId}:` (D-058), so one office can never read another's
 * entry, and an office's entries can be dropped with one prefix scan. Build every tenant cache key here.
 */
export const CacheKeys = {
  tenant(officeId: OfficeId, ...parts: readonly string[]): string {
    assertUuid(officeId, 'officeId');
    if (parts.length === 0 || !parts.every((part) => KEY_PART.test(part))) {
      throw new TenantViolationError('cache key parts must be non-empty and match [A-Za-z0-9._-]+');
    }
    return `o:${officeId}:${parts.join(':')}`;
  },
};

export interface DocumentKeyParts {
  readonly officeId: OfficeId;
  readonly fileId: string;
  readonly documentId: string;
  /** File extension without the dot; the original (Arabic) filename is metadata only (D-035). */
  readonly extension: string;
}

/** `{officeId}/{fileId}/{documentId}/{uuid}.{ext}` (D-035): the office prefix makes a leaked key useless elsewhere. */
export function documentStorageKey({
  officeId,
  fileId,
  documentId,
  extension,
}: DocumentKeyParts): string {
  assertUuid(officeId, 'officeId');
  assertUuid(fileId, 'fileId');
  assertUuid(documentId, 'documentId');
  const ext = extension.toLowerCase();
  if (!EXTENSION.test(ext)) throw new TenantViolationError('extension must match [a-z0-9]{1,10}');
  return `${officeId}/${fileId}/${documentId}/${randomUUID()}.${ext}`;
}

/** Before signing a download/delete URL: the stored key must sit under the current office's prefix. */
export function assertStorageKeyInOffice(key: string, officeId: OfficeId): void {
  const segments = key.split('/');
  if (
    segments[0] !== officeId ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TenantViolationError('storage key is outside the current office');
  }
}
