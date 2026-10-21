import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { getDocumentProxy } from 'unpdf';

import { assertZipWithinLimits } from './zip-limits';

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
/** Pages read from a PDF; the rest of a longer one is not indexed. */
export const MAX_PDF_PAGES = 2000;

export const MIME = {
  PDF: 'application/pdf',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  CSV: 'text/csv',
} as const;

/** Types read here; everything else (images, TIFF, legacy .doc) goes to OCR without being downloaded. */
export const extractable = (mimeType: string): boolean =>
  (Object.values(MIME) as string[]).includes(mimeType);

/** A file that is not what its type says (corrupt, encrypted, truncated, a zip bomb): no retry will read it. */
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

/** Collects lines until MAX_TEXT_CHARS: a huge sheet or PDF stops being read instead of being built whole. */
class TextBudget {
  private readonly lines: string[] = [];
  private size = 0;

  get full(): boolean {
    return this.size >= MAX_TEXT_CHARS;
  }

  add(line: string): void {
    this.lines.push(line);
    this.size += line.length + 1;
  }

  text(separator: string): string {
    return clip(this.lines.join(separator));
  }
}

/**
 * Reads the text out of a stored version by its sniffed MIME type (D-126). Office files are checked against zip bombs
 * first, sheets and PDFs are read with a text budget, and PDFs page by page with a page cap — one upload must not exhaust
 * the shared worker (D-132). Other types go to OCR.
 */
export async function extractText(content: Buffer, mimeType: string): Promise<Extraction> {
  switch (mimeType) {
    case MIME.DOCX:
      return { kind: 'TEXT', engine: 'docx', pageCount: null, text: clip(await docx(content)) };
    case MIME.XLSX:
      return { kind: 'TEXT', engine: 'xlsx', pageCount: null, text: await xlsx(content) };
    case MIME.CSV:
      return { kind: 'TEXT', engine: 'csv', pageCount: null, text: clip(csv(content)) };
    case MIME.PDF:
      return pdf(content);
    default:
      return { kind: 'NEEDS_OCR' };
  }
}

async function docx(content: Buffer): Promise<string> {
  try {
    assertZipWithinLimits(content);
    return (await mammoth.extractRawText({ buffer: content })).value;
  } catch (error) {
    throw new UnreadableDocumentError('docx', { cause: error });
  }
}

/** Every sheet in order, a heading line per sheet, the cells that hold something separated by tabs. */
async function xlsx(content: Buffer): Promise<string> {
  const budget = new TextBudget();
  try {
    assertZipWithinLimits(content);
    // In memory, bounded by the zip limits: exceljs's streaming reader fails on archives that list worksheets before
    // the workbook (as exceljs itself writes them).
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(content as unknown as ArrayBuffer);
    book.eachSheet((sheet) => {
      if (budget.full) return;
      budget.add(`# ${sheet.name}`);
      sheet.eachRow((row) => {
        if (budget.full) return;
        const cells: string[] = [];
        row.eachCell((cell) => cells.push(cell.text ?? ''));
        budget.add(cells.join('\t'));
      });
    });
  } catch (error) {
    throw new UnreadableDocumentError('xlsx', { cause: error });
  }
  return budget.text('\n');
}

/** UTF-8 (BOM stripped); a file that is not valid UTF-8 is read as Windows-1256, the common Arabic legacy encoding. */
function csv(content: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(content);
  } catch {
    return new TextDecoder('windows-1256').decode(content);
  }
}

/** Page by page (never all pages at once), up to MAX_PDF_PAGES and the text budget; the document is always released. */
async function pdf(content: Buffer): Promise<Extraction> {
  const budget = new TextBudget();
  let pageCount: number;
  let characters = 0;
  let read = 0;
  try {
    const document = await getDocumentProxy(new Uint8Array(content));
    try {
      pageCount = document.numPages;
      for (
        let number = 1;
        number <= Math.min(pageCount, MAX_PDF_PAGES) && !budget.full;
        number += 1
      ) {
        const page = await document.getPage(number);
        const { items } = await page.getTextContent();
        const text = items.map((item) => ('str' in item ? item.str : '')).join(' ');
        page.cleanup();
        characters += text.replace(/\s/g, '').length;
        read += 1;
        budget.add(text);
      }
    } finally {
      // What unpdf calls itself: releases the parsed document and its worker-side state.
      await document.loadingTask.destroy();
    }
  } catch (error) {
    throw new UnreadableDocumentError('pdf', { cause: error });
  }
  if (read === 0 || characters / read < MIN_PDF_CHARS_PER_PAGE) return { kind: 'NEEDS_OCR' };
  return { kind: 'TEXT', engine: 'pdf-text-layer', pageCount, text: budget.text('\n\f\n') };
}
