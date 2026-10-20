import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { IncomingFile } from './multipart';
import { storeUpload } from './store-upload';
import type { StorageService } from '../../../common/storage/storage.service';

function storage(fail = false) {
  const stored = new Map<string, Buffer>();
  const fake = {
    put: jest.fn(async (key: string, body: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(chunk as Buffer);
      if (fail) throw new Error('STO-001');
      stored.set(key, Buffer.concat(chunks));
    }),
    delete: jest.fn(async (key: string) => {
      stored.delete(key);
      return Promise.resolve();
    }),
  };
  return { stored, fake, service: fake as unknown as StorageService };
}

const incoming = (chunks: Buffer[], filename = 'brief.pdf', truncated = false): IncomingFile => ({
  filename,
  stream: Readable.from(chunks),
  truncated: () => truncated,
});

describe('storeUpload', () => {
  it('should sniff the head, then stream every byte with its size and SHA-256', async () => {
    const { stored, service } = storage();
    const parts = [Buffer.from('%PDF-1.7\n'), Buffer.alloc(70_000, 1), Buffer.from('%%EOF')];
    const all = Buffer.concat(parts);
    const result = await storeUpload(service, incoming(parts), (ext) => `o/f/d/x.${ext}`);
    expect(result).toEqual({
      key: 'o/f/d/x.pdf',
      mimeType: 'application/pdf',
      sizeBytes: all.length,
      checksumSha256: createHash('sha256').update(all).digest('hex'),
    });
    expect(stored.get('o/f/d/x.pdf')?.equals(all)).toBe(true);
  });

  it('should refuse a type it does not allow without storing anything (VAL-005)', async () => {
    const { fake, service } = storage();
    await expect(
      storeUpload(service, incoming([Buffer.from('MZ\0'), Buffer.alloc(80_000)]), () => 'k'),
    ).rejects.toMatchObject({ code: 'VAL-005' });
    expect(fake.put).not.toHaveBeenCalled();
  });

  it('should delete a file cut at the size limit (VAL-006) or whose upload failed', async () => {
    const cut = storage();
    await expect(
      storeUpload(cut.service, incoming([Buffer.from('%PDF-')], 'a.pdf', true), () => 'k1'),
    ).rejects.toMatchObject({ code: 'VAL-006' });
    expect(cut.fake.delete).toHaveBeenCalledWith('k1');
    const failed = storage(true);
    await expect(
      storeUpload(failed.service, incoming([Buffer.from('%PDF-')]), () => 'k2'),
    ).rejects.toThrow('STO-001');
    expect(failed.fake.delete).toHaveBeenCalledWith('k2');
  });
});
