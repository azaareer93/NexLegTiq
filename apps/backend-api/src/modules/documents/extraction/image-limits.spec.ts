import { UnreadableDocumentError } from './extract-text';
import { jpegHeader, pngHeader, tiffHeader } from './fixtures.test-helper';
import { assertImageWithinLimits, imageInfo, MAX_PIXELS } from './image-limits';

describe('image limits (D-139)', () => {
  it('should read the size a PNG, JPEG or TIFF declares, and a TIFF’s pages', () => {
    expect(imageInfo(pngHeader(2480, 3508), 'image/png')).toEqual({
      pixels: 2480 * 3508,
      pages: 1,
    });
    expect(imageInfo(jpegHeader(1141, 536), 'image/jpeg')).toEqual({
      pixels: 1141 * 536,
      pages: 1,
    });
    expect(imageInfo(tiffHeader(1000, 2000, 3), 'image/tiff')).toEqual({
      pixels: 2_000_000,
      pages: 3,
    });
  });

  it('should not read truncated or foreign headers, nor a TIFF whose pages loop', () => {
    expect(imageInfo(pngHeader(10, 10).subarray(0, 18), 'image/png')).toBeNull();
    expect(imageInfo(Buffer.from([0xff, 0xd8, 0x00, 0x00]), 'image/jpeg')).toBeNull();
    expect(imageInfo(Buffer.from('MM\0+'), 'image/tiff')).toBeNull();
    const looping = tiffHeader(10, 10, 1);
    looping.writeUInt32LE(8, 8 + 26); // the only page points back to itself
    expect(imageInfo(looping, 'image/tiff')).toBeNull();
  });

  it('should skip JPEG fill bytes and other segments, read big-endian TIFF sizes, and refuse other headers', () => {
    const jpeg = Buffer.alloc(23);
    // SOI, a fill byte, an APP0 segment of 4 bytes, then SOF0 declaring 10 × 20.
    Buffer.from([
      0xff, 0xd8, 0xff, 0xff, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08,
    ]).copy(jpeg);
    jpeg.writeUInt16BE(10, 15);
    jpeg.writeUInt16BE(20, 17);
    expect(imageInfo(jpeg, 'image/jpeg')).toEqual({ pixels: 200, pages: 1 });
    expect(
      imageInfo(Buffer.alloc(14, 0).fill(0xff, 0, 1).fill(0xd8, 1, 2), 'image/jpeg'),
    ).toBeNull();

    // Big-endian TIFF, one IFD: width as SHORT (100), length as LONG (50), and a tag that is not a size.
    const tiff = Buffer.alloc(50);
    tiff.write('MM', 0, 'latin1');
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(3, 8);
    const entry = (index: number, tag: number, type: number, write: (at: number) => void) => {
      const at = 10 + index * 12;
      tiff.writeUInt16BE(tag, at);
      tiff.writeUInt16BE(type, at + 2);
      tiff.writeUInt32BE(1, at + 4);
      write(at + 8);
    };
    entry(0, 256, 3, (at) => tiff.writeUInt16BE(100, at));
    entry(1, 257, 4, (at) => tiff.writeUInt32BE(50, at));
    entry(2, 258, 3, (at) => tiff.writeUInt16BE(8, at));
    expect(imageInfo(tiff, 'image/tiff')).toEqual({ pixels: 5000, pages: 1 });

    const noPages = Buffer.alloc(8);
    noPages.write('II', 0, 'latin1');
    noPages.writeUInt16LE(42, 2);
    expect(imageInfo(noPages, 'image/tiff')).toBeNull();
    expect(imageInfo(Buffer.alloc(24), 'image/png')).toBeNull();
    expect(imageInfo(pngHeader(10, 10), 'image/gif')).toBeNull();
  });

  it('should refuse pixel bombs, too many pages and unreadable headers as unreadable (VAL-005)', () => {
    expect(() => assertImageWithinLimits(pngHeader(2480, 3508), 'image/png', 50)).not.toThrow();
    const side = Math.ceil(Math.sqrt(MAX_PIXELS)) + 1;
    expect(() => assertImageWithinLimits(pngHeader(side, side), 'image/png', 50)).toThrow(
      UnreadableDocumentError,
    );
    expect(() => assertImageWithinLimits(jpegHeader(60_000, 60_000), 'image/jpeg', 50)).toThrow(
      UnreadableDocumentError,
    );
    expect(() => assertImageWithinLimits(tiffHeader(100, 100, 3), 'image/tiff', 2)).toThrow(
      UnreadableDocumentError,
    );
    expect(() => assertImageWithinLimits(Buffer.from('nope'), 'image/png', 50)).toThrow(
      UnreadableDocumentError,
    );
  });
});
