/** What an Office file (a ZIP) may unpack to before it is parsed (D-132): a 50 MB upload cannot become gigabytes. */
export const ZIP_LIMITS = {
  /** Total uncompressed size of all entries. */
  maxUncompressedBytes: 100 * 1024 * 1024,
  /** Uncompressed size over the file's size: text compresses about 5–20×, bombs 1000×. */
  maxRatio: 100,
  maxEntries: 10_000,
} as const;

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;

/**
 * Reads the ZIP's central directory (sizes as the archive declares them) and throws when the archive would unpack beyond
 * `ZIP_LIMITS`, or cannot be read. ZIP64 archives (an Office file never needs one at 50 MB) are refused too.
 */
export function assertZipWithinLimits(zip: Buffer): void {
  const end = endOfCentralDirectory(zip);
  const entries = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  if (entries === 0xffff || offset === 0xffffffff)
    throw new Error('ZIP64 archives are not accepted');
  if (entries > ZIP_LIMITS.maxEntries) throw new Error('Too many entries');
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error('Damaged central directory');
    }
    total += zip.readUInt32LE(offset + 24);
    if (total > ZIP_LIMITS.maxUncompressedBytes) throw new Error('Unpacks too large');
    offset +=
      46 +
      zip.readUInt16LE(offset + 28) +
      zip.readUInt16LE(offset + 30) +
      zip.readUInt16LE(offset + 32);
  }
  if (total > zip.length * ZIP_LIMITS.maxRatio) throw new Error('Compression ratio too high');
}

/** The end-of-central-directory record is in the last 22 + 65,535 bytes (its comment is at most 64 KiB). */
function endOfCentralDirectory(zip: Buffer): number {
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at -= 1) {
    if (zip.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  throw new Error('Not a ZIP archive');
}
