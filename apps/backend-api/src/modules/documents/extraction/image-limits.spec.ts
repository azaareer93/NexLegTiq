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
