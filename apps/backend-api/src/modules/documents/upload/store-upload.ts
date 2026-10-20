import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import { MAX_UPLOAD_BYTES } from '@nexlegtiq/shared-contracts';

import { SNIFF_BYTES, sniffFileType } from './file-type';
import { tooLarge } from './multipart';
import type { IncomingFile } from './multipart';
import { AppException } from '../../../common/errors/app.exception';
import type { StorageService } from '../../../common/storage/storage.service';

export interface StoredUpload {
  readonly key: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
}

/** Drains what is left of a refused upload, so the request ends and the client gets its answer. */
async function drain(rest: AsyncIterator<Buffer>): Promise<void> {
  for (let next = await rest.next(); !next.done; next = await rest.next()) {
    // discard
  }
}

/**
 * Streams an upload to storage (D-035, D-126): the first 64 KiB are held back to judge the type from its bytes (415
 * VAL-005 when not allowed or not matching the name), then everything streams on to `keyOf(ext)` while its size and
 * SHA-256 are computed — the file is never held in memory whole. A file cut at the size limit is deleted again (413
 * VAL-006); so is one whose upload failed half-way (STO-001).
 */
export async function storeUpload(
  storage: StorageService,
  file: IncomingFile,
  keyOf: (ext: string) => string,
): Promise<StoredUpload> {
  const rest = (file.stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  const parts: Buffer[] = [];
  let headBytes = 0;
  while (headBytes < SNIFF_BYTES) {
    const next = await rest.next();
    if (next.done) break;
    parts.push(next.value);
    headBytes += next.value.length;
  }
  const head = Buffer.concat(parts);
  const type = sniffFileType(head, file.filename);
  if (!type) {
    await drain(rest);
    throw new AppException('VAL-005', 'File type not allowed or not matching its name');
  }

  const hash = createHash('sha256');
  let sizeBytes = 0;
  async function* body(): AsyncGenerator<Buffer> {
    for (let chunk: Buffer | undefined = head; chunk;) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      yield chunk;
      const next = await rest.next();
      chunk = next.done ? undefined : next.value;
    }
  }
  const key = keyOf(type.ext);
  try {
    await storage.put(key, Readable.from(body()), { contentType: type.mimeType });
    if (file.truncated() || sizeBytes > MAX_UPLOAD_BYTES) throw tooLarge();
  } catch (error) {
    await storage.delete(key).catch(() => undefined);
    throw error;
  }
  return { key, mimeType: type.mimeType, sizeBytes, checksumSha256: hash.digest('hex') };
}
