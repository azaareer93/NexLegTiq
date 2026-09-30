import type { OfficeId } from '@nexlegtiq/shared-types';

import { assertStorageKeyInOffice, CacheKeys, documentStorageKey } from './tenant-keys';
import { TenantViolationError } from './tenant.errors';

const A = '01920000-0000-7000-8000-00000000000a' as OfficeId;
const B = '01920000-0000-7000-8000-00000000000b' as OfficeId;
const FILE = '01920000-0000-7000-8000-0000000000f1';
const DOC = '01920000-0000-7000-8000-0000000000d1';

describe('CacheKeys.tenant', () => {
  it('should prefix keys with o:{officeId}:', () => {
    expect(CacheKeys.tenant(A, 'search', 'abc123')).toBe(`o:${A}:search:abc123`);
  });

  it.each([
    ['no parts', []],
    ['an empty part', ['search', '']],
    ['a colon (could forge another prefix)', [`x:o:${B}`]],
  ])('should reject %s', (_label, parts) => {
    expect(() => CacheKeys.tenant(A, ...parts)).toThrow(TenantViolationError);
  });

  it('should reject a non-UUID office', () => {
    expect(() => CacheKeys.tenant('*' as OfficeId, 'search')).toThrow(TenantViolationError);
  });
});

describe('documentStorageKey', () => {
  it('should build {officeId}/{fileId}/{documentId}/{uuid}.{ext}', () => {
    expect(documentStorageKey({ officeId: A, fileId: FILE, documentId: DOC, extension: 'PDF' })).toMatch(
      new RegExp(`^${A}/${FILE}/${DOC}/[0-9a-f-]{36}\\.pdf$`),
    );
  });

  it.each([
    ['a non-UUID file id', { fileId: '../x' }],
    ['an extension with a dot', { extension: 'tar.gz' }],
    ['an extension with a slash', { extension: 'pdf/../x' }],
  ])('should reject %s', (_label, override) => {
    expect(() => documentStorageKey({ officeId: A, fileId: FILE, documentId: DOC, extension: 'pdf', ...override })).toThrow(
      TenantViolationError,
    );
  });
});

describe('assertStorageKeyInOffice', () => {
  it('should accept a key under the office prefix', () => {
    expect(() => assertStorageKeyInOffice(`${A}/${FILE}/${DOC}/x.pdf`, A)).not.toThrow();
  });

  it.each([
    ['another office', `${B}/${FILE}/${DOC}/x.pdf`],
    ['a prefix look-alike', `${A}x/${FILE}/x.pdf`],
    ['path traversal', `${A}/../${B}/x.pdf`],
    ['an empty segment', `${A}//x.pdf`],
  ])('should reject %s', (_label, key) => {
    expect(() => assertStorageKeyInOffice(key, A)).toThrow(TenantViolationError);
  });
});
