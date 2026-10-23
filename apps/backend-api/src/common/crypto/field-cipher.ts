import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { toWesternDigits } from '@nexlegtiq/shared-utils';

import { AppConfig } from '../../config/app-config';

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * App-level encryption of never-searched sensitive fields (D-056, ops-security.md): AES-256-GCM, a fresh 96-bit IV per
 * value, stored as `v1:<base64url(iv | tag | ciphertext)>` (the `v<n>:` prefix is what the database CHECKs require).
 * `context` is bound as additional data (e.g. `clients.national_id:<officeId>`), so a value copied to another column or
 * office fails to decrypt instead of being read there.
 * ponytail: one key (version 1); rotation adds older keys by version and a re-encrypt job when it is first needed.
 */
@Injectable()
export class FieldCipher {
  readonly #key: Buffer;
  /** A separate key for blind indexes, derived from the field key, so an index never reveals anything about ciphertexts. */
  readonly #indexKey: Buffer;

  constructor(config: AppConfig) {
    this.#key = Buffer.from(config.encryptionKey, 'hex');
    this.#indexKey = Buffer.from(hkdfSync('sha256', this.#key, '', 'nexlegtiq blind index v1', 32));
  }

  /**
   * Blind index of an identifier (D-135): HMAC-SHA256 of the value with digits made Western and everything but letters and
   * digits dropped, upper-cased — so `٤٠١ 234-567` and `401234567` match. `scope` (e.g. `national_id:<officeId>`) keeps
   * indexes of different kinds and offices apart. Exact match only; null for an empty value.
   */
  blindIndex(value: string | null | undefined, scope: string): string | null {
    const normalized = toWesternDigits(value ?? '')
      .replace(/[^\p{L}\p{N}]/gu, '')
      .toUpperCase();
    if (!normalized) return null;
    return createHmac('sha256', this.#indexKey).update(`${scope}:${normalized}`).digest('hex');
  }

  encrypt(plain: string, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url')}`;
  }

  /** Throws (→ 500 SYS-001) on an unknown version, a wrong context or tampered data; never returns garbage. */
  decrypt(stored: string, context: string): string {
    const [version, payload, ...rest] = stored.split(':');
    if (version !== VERSION || payload === undefined || rest.length > 0) {
      throw new Error('Unsupported ciphertext format');
    }
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error('Unsupported ciphertext format');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, bytes.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  }
}
