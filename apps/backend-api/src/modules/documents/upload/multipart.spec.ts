import { PassThrough, Readable } from 'node:stream';

import { MAX_UPLOAD_BYTES, UploadDocumentFieldsSchema } from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';

import { readUpload } from './multipart';

const FILE_ID = '01920000-0000-7000-8000-000000000001';

type Part = { name: string; value: string } | { name: string; filename: string; data: Buffer };

function formRequest(parts: Part[], headers: Record<string, string> = {}): Request {
  const boundary = 'nlq-test-boundary';
  const chunks = parts.flatMap((part) => [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"` +
        ('filename' in part
          ? `; filename="${part.filename}"\r\nContent-Type: application/octet-stream`
          : '') +
        '\r\n\r\n',
    ),
    'filename' in part ? part.data : Buffer.from(part.value),
    Buffer.from('\r\n'),
  ]);
  const body = Buffer.concat([...chunks, Buffer.from(`--${boundary}--\r\n`)]);
  return Object.assign(Readable.from([body]), {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
      ...headers,
    },
  }) as unknown as Request;
}

const read = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
};

describe('readUpload', () => {
  it('should error the file stream when the client aborts mid-upload, instead of waiting forever', async () => {
    const boundary = 'nlq-abort';
    const req = Object.assign(new PassThrough(), {
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    const crlf = String.fromCharCode(13, 10);
    req.write(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="fileId"',
        '',
        FILE_ID,
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="a.pdf"',
        '',
        '%PDF-1.7 partial',
      ].join(crlf),
    );
    const { file } = await readUpload(req as unknown as Request, UploadDocumentFieldsSchema);
    const reading = read(file.stream);
    req.destroy(new Error('aborted'));
    await expect(reading).rejects.toThrow('aborted');
  });

  it('should validate the fields, then hand over the file as a stream with its bare name', async () => {
    const { fields, file } = await readUpload(
      formRequest([
        { name: 'fileId', value: FILE_ID },
        { name: 'isConfidential', value: 'true' },
        { name: 'unknown', value: 'ignored' },
        { name: 'file', filename: 'C:\\fakepath\\عقد.pdf', data: Buffer.from('%PDF-1.7') },
      ]),
      UploadDocumentFieldsSchema,
    );
    expect(fields).toEqual({ fileId: FILE_ID, documentType: 'OTHER', isConfidential: true });
    expect(file.filename).toBe('عقد.pdf');
    expect(await read(file.stream)).toBe('%PDF-1.7');
    expect(file.truncated()).toBe(false);
  });

  it('should refuse invalid fields and a bidi-spoofed name together (VAL-001)', async () => {
    await expect(
      readUpload(
        formRequest([
          { name: 'fileId', value: 'nope' },
          { name: 'file', filename: 'gpj\u202Eexe.pdf', data: Buffer.from('x') },
        ]),
        UploadDocumentFieldsSchema,
      ),
    ).rejects.toMatchObject({
      code: 'VAL-001',
      details: [
        expect.objectContaining({ field: 'fileId' }),
        { field: 'file', message: 'validation.invalidCharacters' },
      ],
    });
  });

  it('should refuse a bad name even when the fields are valid', async () => {
    await expect(
      readUpload(
        formRequest([
          { name: 'fileId', value: FILE_ID },
          { name: 'file', filename: '', data: Buffer.from('x') },
        ]),
        UploadDocumentFieldsSchema,
      ),
    ).rejects.toMatchObject({ code: 'VAL-001', details: [{ field: 'file' }] });
  });

  it('should take only the first file part, and refuse a form whose first file is not `file`', async () => {
    await expect(
      readUpload(
        formRequest([
          { name: 'fileId', value: FILE_ID },
          { name: 'attachment', filename: 'x.pdf', data: Buffer.from('x') },
          { name: 'file', filename: 'y.pdf', data: Buffer.from('y') },
        ]),
        UploadDocumentFieldsSchema,
      ),
    ).rejects.toMatchObject({ code: 'VAL-001', details: [{ field: 'file' }] });
  });

  it('should refuse a form without a file, a body that is not multipart, and one announced too large', async () => {
    await expect(
      readUpload(formRequest([{ name: 'fileId', value: FILE_ID }]), UploadDocumentFieldsSchema),
    ).rejects.toMatchObject({ code: 'VAL-001', details: [{ field: 'file' }] });
    const json = Object.assign(Readable.from(['{}']), {
      headers: { 'content-type': 'application/json' },
    }) as unknown as Request;
    await expect(readUpload(json, UploadDocumentFieldsSchema)).rejects.toMatchObject({
      code: 'VAL-005',
    });
    const huge = formRequest([], { 'content-length': String(MAX_UPLOAD_BYTES * 2) });
    await expect(readUpload(huge, UploadDocumentFieldsSchema)).rejects.toMatchObject({
      code: 'VAL-006',
    });
  });
});
