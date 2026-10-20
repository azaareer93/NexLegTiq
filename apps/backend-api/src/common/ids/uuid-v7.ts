import { randomBytes } from 'node:crypto';

/**
 * A UUID v7 (RFC 9562: 48-bit Unix milliseconds, then random bits), as the database's `uuid(7)` default makes them — for
 * ids the app needs before the insert, e.g. a document's storage key `{officeId}/{fileId}/{documentId}/…` (D-035).
 */
export function uuidV7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
