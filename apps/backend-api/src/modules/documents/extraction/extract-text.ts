import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText as pdfText, getDocumentProxy } from 'unpdf';

/** The text of a document, or the sign that it needs OCR (scans, images, PDFs without a text layer — D-132). */
export type Extraction =
  | {
      readonly kind: 'TEXT';
      readonly text: string;
      readonly pageCount: number | null;
      readonly engine: 'docx' | 'xlsx' | 'csv' | 'pdf-text-layer';
    }
  | { readonly kind: 'NEEDS_OCR' };

/** Average characters per page under which a PDF counts as scanned (ai-ocr.md). */
export const MIN_PDF_CHARS_PER_PAGE = 50;
/** Text kept per version; the search vectors index the first 500,000 characters (D-119). */
export const MAX_TEXT_CHARS = 5_000_000;

export const MIME = {
  PDF: 'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  CSV: 'text/csv',
} as const;

/** A file that is not what its type says (corrupt, encrypted, truncated): extraction cannot succeed, retrying won't help. */
export class UnreadableDocumentError extends Error {
  constructor(engine: string, options?: { cause?: unknown }) {
    super(`The ${engine} content could not be read`, options);
    this.name = 'UnreadableDocumentError';
  }
}

/** PostgreSQL text cannot hold NUL characters (some PDFs and spreadsheets contain them). */
const NUL = String.fromCharCode(0);

const clip = (text: string): string =>
  (text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text).replaceAll(NUL, '');

/** Reads the text out of a stored version by its sniffed MIME type (D-126); other types go to OCR. */
export async function extractText(content: Buffer, mimeType: string): Promise<Extraction> {
  switch (mimeType) {
    case MIME.DOCX:
      return { kind: 'TEXT', engine: 'docx', pageCount: null, text: clip(await docx(content)) };
    case MIME.XLSX:
      return { kind: 'TEXT', engine: 'xlsx', pageCount: null, text: clip(await xlsx(content)) };
    case MIME.CSV:
      return { kind: 'TEXT', engine: 'csv', pageCount: null, text: clip(csv(content)) };
    case MIME.PDF:
      return pdf(content);
    default:
      // Images, TIFF and legacy .doc: the OCR path (Tesseract) handles them.
      return { kind: 'NEEDS_OCR' };
  }
}

async function docx(content: Buffer): Promise<string> {
  try {
    return (await mammoth.extractRawText({ buffer: content })).value;
  } catch (error) {
    throw new UnreadableDocumentError('docx', { cause: error });
  }
}

/** Every sheet in order, a heading line per sheet, cells separated by tabs (formulas give their last result). */
async function xlsx(content: Buffer): Promise<string> {
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(content as unknown as ArrayBuffer);
  } catch (error) {
    throw new UnreadableDocumentError('xlsx', { cause: error });
  }
  const lines: string[] = [];
  book.eachSheet((sheet) => {
    lines.push(`# ${sheet.name}`);
    sheet.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => cells.push(cell.text ?? ''));
      lines.push(cells.join('\t').trimEnd());
    });
  });
  return lines.join('\n');
}

/** UTF-8 (BOM stripped); a file that is not valid UTF-8 is read as Windows-1256, the common Arabic legacy encoding. */
function csv(content: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(content);
  } catch {
    return new TextDecoder('windows-1256').decode(content);
  }
}

async function pdf(content: Buffer): Promise<Extraction> {
  let pages: string[];
  let pageCount: number;
  try {
    const document = await getDocumentProxy(new Uint8Array(content));
    const result = await pdfText(document, { mergePages: false });
    pages = result.text;
    pageCount = result.totalPages;
  } catch (error) {
    throw new UnreadableDocumentError('pdf', { cause: error });
  }
  const characters = pages.reduce((sum, page) => sum + page.replace(/\s/g, '').length, 0);
  if (pageCount === 0 || characters / pageCount < MIN_PDF_CHARS_PER_PAGE)
    return { kind: 'NEEDS_OCR' };
  return { kind: 'TEXT', engine: 'pdf-text-layer', pageCount, text: clip(pages.join('\n\f\n')) };
}
