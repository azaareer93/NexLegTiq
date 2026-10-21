import { extractText, MIME, UnreadableDocumentError } from './extract-text';
import { buildDocx } from './fixtures.test-helper';
import { assertZipWithinLimits, ZIP_LIMITS } from './zip-limits';

/** Rewrites the uncompressed size every central-directory entry declares (what a zip bomb looks like to us). */
function declaring(zip: Buffer, uncompressed: number): Buffer {
  const copy = Buffer.from(zip);
  for (let at = 0; at + 4 <= copy.length; at += 1) {
    if (copy.readUInt32LE(at) === 0x02014b50) copy.writeUInt32LE(uncompressed, at + 24);
  }
  return copy;
}

describe('assertZipWithinLimits (D-132)', () => {
  const docx = buildDocx(['A short lease.']);

  it('should accept an ordinary Office file', () => {
    expect(() => assertZipWithinLimits(docx)).not.toThrow();
  });

  it('should refuse archives that would unpack too large or too far beyond their size', () => {
    expect(() => assertZipWithinLimits(declaring(docx, ZIP_LIMITS.maxUncompressedBytes))).toThrow(
      'Unpacks too large',
    );
    expect(() => assertZipWithinLimits(declaring(docx, docx.length * 50))).toThrow(
      'Compression ratio too high',
    );
  });

  it('should refuse what is not a sound ZIP', () => {
    expect(() => assertZipWithinLimits(Buffer.from('not a zip at all'))).toThrow('Not a ZIP');
    const damaged = Buffer.from(docx);
    damaged.writeUInt32LE(0, damaged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])));
    expect(() => assertZipWithinLimits(damaged)).toThrow('Damaged central directory');
  });

  it('should make extraction refuse a zip bomb as unreadable, before any parsing', async () => {
    await expect(
      extractText(declaring(docx, ZIP_LIMITS.maxUncompressedBytes + 1), MIME.DOCX),
    ).rejects.toBeInstanceOf(UnreadableDocumentError);
  });
});
