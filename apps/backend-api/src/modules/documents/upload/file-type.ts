/** How many leading bytes the sniffer reads (enough for the local headers of an Office file's first ZIP entries). */
export const SNIFF_BYTES = 64 * 1024;

export interface SniffedType {
  /** The extension the object is stored under (canonical: `jpg`, `tiff`). */
  readonly ext: string;
  readonly mimeType: string;
}

type Kind = 'pdf' | 'png' | 'jpg' | 'tiff' | 'doc' | 'docx' | 'xlsx' | 'csv';

/** The D-035 allow-list: what each kind is stored as, and the extensions a name of that kind may carry. */
const KINDS: Record<Kind, { mimeType: string; exts: readonly string[] }> = {
  pdf: { mimeType: 'application/pdf', exts: ['pdf'] },
  png: { mimeType: 'image/png', exts: ['png'] },
  jpg: { mimeType: 'image/jpeg', exts: ['jpg', 'jpeg'] },
  tiff: { mimeType: 'image/tiff', exts: ['tiff', 'tif'] },
  doc: { mimeType: 'application/msword', exts: ['doc'] },
  docx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    exts: ['docx'],
  },
  xlsx: {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    exts: ['xlsx'],
  },
  csv: { mimeType: 'text/csv', exts: ['csv'] },
};

const MAGIC: readonly [Kind, readonly number[]][] = [
  ['pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]], // %PDF-
  ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['jpg', [0xff, 0xd8, 0xff]],
  ['tiff', [0x49, 0x49, 0x2a, 0x00]], // II*.
  ['tiff', [0x4d, 0x4d, 0x00, 0x2a]], // MM.*
  ['doc', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]], // OLE2 compound file
];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

const startsWith = (head: Buffer, bytes: readonly number[]) =>
  head.length >= bytes.length && bytes.every((byte, index) => head[index] === byte);

/**
 * An Office Open XML file is a ZIP whose entry names (stored in plain text in each local header) say what it is.
 * shortcut: looks for the names in the first 64 KiB, where Word and Excel write them; a package whose first entries are
 * larger is refused (VAL-005) — read the central directory if real files ever hit that.
 */
function officeKind(head: Buffer): Kind | null {
  const text = head.toString('latin1');
  if (!text.includes('[Content_Types].xml')) return null;
  const word = text.includes('word/');
  const excel = text.includes('xl/');
  if (word === excel) return null;
  return word ? 'docx' : 'xlsx';
}

function detect(head: Buffer, ext: string): Kind | null {
  for (const [kind, bytes] of MAGIC) if (startsWith(head, bytes)) return kind;
  if (startsWith(head, ZIP)) return officeKind(head);
  // CSV has no signature: plain text (any encoding — Excel writes Arabic CSV as Windows-1256) with no NUL byte, which
  // every binary format in practice contains near its start.
  if (ext === 'csv' && head.length > 0 && !head.includes(0)) return 'csv';
  return null;
}

export const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
};

/**
 * The type of an upload judged by its leading bytes, never by its name or the browser's Content-Type (D-035): one of the
 * allowed kinds, and the name's extension must belong to that kind — a renamed executable or a PNG called `.pdf` is
 * refused (null → 415 VAL-005).
 */
export function sniffFileType(head: Buffer, filename: string): SniffedType | null {
  const ext = extensionOf(filename);
  const kind = detect(head, ext);
  if (!kind || !KINDS[kind].exts.includes(ext)) return null;
  return { ext: kind, mimeType: KINDS[kind].mimeType };
}
