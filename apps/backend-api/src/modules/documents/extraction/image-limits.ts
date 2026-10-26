import { UnreadableDocumentError } from './extract-text';

/**
 * Largest page Tesseract is given, in pixels: an A4 page at 600 dpi is 35 MP. A small file can declare a huge image
 * (a pixel bomb) that would make the decoder allocate gigabytes on the shared worker (D-139).
 */
export const MAX_PIXELS = 50_000_000;

export interface ImageInfo {
  /** Pixels of the largest page. */
  readonly pixels: number;
  readonly pages: number;
}

const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** The size an image header declares — PNG (IHDR), JPEG (SOF), TIFF (every IFD) — or null when it cannot be read. */
export function imageInfo(content: Buffer, mimeType: string): ImageInfo | null {
  try {
    if (mimeType === 'image/png') {
      // The first chunk must be IHDR, which holds width and height.
      if (content.toString('latin1', 12, 16) !== 'IHDR') return null;
      return { pixels: content.readUInt32BE(16) * content.readUInt32BE(20), pages: 1 };
    }
    if (mimeType === 'image/jpeg') return jpeg(content);
    if (mimeType === 'image/tiff') return tiff(content);
  } catch {
    // A read past the end: a truncated header.
  }
  return null;
}

function jpeg(content: Buffer): ImageInfo | null {
  let offset = 2;
  while (offset + 9 <= content.length) {
    if (content[offset] !== 0xff) return null;
    const marker = content[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (JPEG_SOF.has(marker)) {
      return {
        pixels: content.readUInt16BE(offset + 5) * content.readUInt16BE(offset + 7),
        pages: 1,
      };
    }
    offset += 2 + content.readUInt16BE(offset + 2);
  }
  return null;
}

interface TiffReader {
  readonly u16: (at: number) => number;
  readonly u32: (at: number) => number;
}

/** Walks the IFD chain (pages), bounded and loop-safe; BigTIFF is not read (null). */
function tiff(content: Buffer): ImageInfo | null {
  const order = content.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const read: TiffReader = {
    u16: (at) => (little ? content.readUInt16LE(at) : content.readUInt16BE(at)),
    u32: (at) => (little ? content.readUInt32LE(at) : content.readUInt32BE(at)),
  };
  if (read.u16(2) !== 42) return null;
  const seen = new Set<number>();
  let pixels = 0;
  for (let ifd = read.u32(4); ifd !== 0;) {
    if (seen.has(ifd) || seen.size > 10_000) return null;
    seen.add(ifd);
    const page = tiffPage(read, ifd);
    pixels = Math.max(pixels, page.pixels);
    ifd = page.next;
  }
  return seen.size ? { pixels, pages: seen.size } : null;
}

/** One IFD: its ImageWidth (256) × ImageLength (257), SHORT or LONG, and the offset of the next IFD. */
function tiffPage({ u16, u32 }: TiffReader, ifd: number): { pixels: number; next: number } {
  const entries = u16(ifd);
  const size: Record<number, number> = { 256: 0, 257: 0 };
  for (let index = 0; index < entries; index += 1) {
    const entry = ifd + 2 + index * 12;
    const tag = u16(entry);
    if (tag in size) size[tag] = u16(entry + 2) === 3 ? u16(entry + 8) : u32(entry + 8);
  }
  return { pixels: (size[256] ?? 0) * (size[257] ?? 0), next: u32(ifd + 2 + entries * 12) };
}

/** Refuses (VAL-005, no retry) an image whose header cannot be read, a page over MAX_PIXELS, or more pages than allowed. */
export function assertImageWithinLimits(content: Buffer, mimeType: string, maxPages: number): void {
  const info = imageInfo(content, mimeType);
  if (!info || info.pixels > MAX_PIXELS || info.pages > maxPages) {
    throw new UnreadableDocumentError('image');
  }
}
