import { pipeline } from 'node:stream';
import type { Readable } from 'node:stream';

import { MAX_UPLOAD_BYTES, OriginalFilenameSchema } from '@nexlegtiq/shared-contracts';
import busboy from 'busboy';
import type { Request } from 'express';
import type { z } from 'zod';

import { AppException, ValidationException } from '../../../common/errors/app.exception';
import { zodIssuesToDetails } from '../../../common/http/zod-validation.pipe';

/** Room for the form's text fields and part headers on top of the file itself. */
const FORM_OVERHEAD_BYTES = 64 * 1024;

export interface IncomingFile {
  /** The uploaded name without any path a browser added (`C:\fakepath\…`); Arabic kept as sent. */
  readonly filename: string;
  readonly stream: Readable;
  /** True once more than `MAX_UPLOAD_BYTES` arrived: the stream was cut short and must not be kept. */
  readonly truncated: () => boolean;
}

export const tooLarge = () => new AppException('VAL-006', 'The file is larger than 50 MB');

/**
 * Reads the rest of a body without keeping it, and settles once it has all arrived (or the client went away): answering
 * while a client still sends resets the connection, and it never sees the answer. Bounded by the server's request timeout.
 */
export function discardBody(req: Request): Promise<void> {
  if (req.readableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    req.once('end', resolve);
    req.once('close', resolve);
    req.once('error', () => resolve());
    req.resume();
  });
}

const missingFile = () =>
  new ValidationException([{ field: 'file', message: 'validation.required' }]);

/**
 * Reads a `multipart/form-data` upload as a stream (D-126): the text fields must come before the `file` part, so they are
 * validated with `schema` (400 VAL-001) — and the caller checks access — before a byte of the file is stored. Resolves at
 * the `file` part; nothing is buffered. A body announced larger than the limit is refused at once (413 VAL-006), one that
 * is not multipart is 415 VAL-005. On a refusal the rest of the body is drained, so the client gets the answer.
 */
export function readUpload<S extends z.ZodType>(
  req: Request,
  schema: S,
  /** The largest file the route accepts (documents: 50 MiB; the avatar route passes its own, smaller cap). */
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<{ fields: z.output<S>; file: IncomingFile }> {
  const announced = Number(req.headers['content-length'] ?? 0);
  if (announced > maxBytes + FORM_OVERHEAD_BYTES) {
    // Discarded unread: nothing is parsed or stored.
    return discardBody(req).then(() => Promise.reject(tooLarge()));
  }
  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      // One byte over the limit, so a file of exactly the limit is not cut (busboy cuts at the limit itself).
      limits: { files: 1, fields: 10, fieldSize: 4096, parts: 12, fileSize: maxBytes + 1 },
    });
  } catch {
    return discardBody(req).then(() =>
      Promise.reject(new AppException('VAL-005', 'Expected a multipart/form-data upload')),
    );
  }
  return new Promise((resolve, reject) => {
    const raw: Record<string, string> = {};
    let refusal: ValidationException | undefined;
    parser.on('field', (name, value) => {
      raw[name] = value;
    });
    parser.on('file', (name, stream, info) => {
      if (name !== 'file') {
        stream.resume();
        return;
      }
      const fields = schema.safeParse(raw);
      // busboy reports an empty `filename=""` as undefined, whatever its types say.
      const sent = (info.filename as string | undefined) ?? '';
      const filename = OriginalFilenameSchema.safeParse(sent.replace(/^.*[/\\]/, ''));
      if (!fields.success || !filename.success) {
        // Answered once the body has been read (`close`), so the client is still listening.
        stream.resume();
        refusal = new ValidationException([
          ...(fields.success ? [] : zodIssuesToDetails(fields.error.issues)),
          ...(filename.success
            ? []
            : filename.error.issues.map((issue) => ({ field: 'file', message: issue.message }))),
        ]);
        return;
      }
      let truncated = false;
      stream.on('limit', () => {
        truncated = true;
      });
      resolve({
        fields: fields.data,
        file: { filename: filename.data, stream, truncated: () => truncated },
      });
    });
    // Settling twice is a no-op: after the file part this changes nothing.
    parser.on('close', () => reject(refusal ?? missingFile()));
    // `pipeline`, not `pipe`: a client that aborts or times out destroys the parser, which errors the file stream, so
    // the storage upload fails and is cleaned up instead of waiting forever.
    pipeline(req, parser, (error) => {
      if (error) reject(error);
    });
  });
}
