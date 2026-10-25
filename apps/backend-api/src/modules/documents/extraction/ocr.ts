import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { clip, MIME } from './extract-text';

const run = promisify(execFile);

/** Types Tesseract reads (D-139): scanned PDFs after rasterizing, and images. */
export const OCR_MIME = {
  PDF: MIME.PDF,
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  TIFF: 'image/tiff',
} as const;

export const ocrable = (mimeType: string): boolean =>
  (Object.values(OCR_MIME) as string[]).includes(mimeType);

export interface OcrResult {
  readonly text: string;
  readonly pageCount: number;
  /** Word-weighted mean over every page, 0–100; null when no word was recognised. */
  readonly confidence: number | null;
  /** Mean word confidence of each page, in page order; null for a page without words. */
  readonly pageConfidences: readonly (number | null)[];
}

export interface OcrOptions {
  /** Pages of a PDF to read (`OCR_MAX_PAGES`); the rest of a longer one is not indexed. */
  readonly maxPages: number;
  /** Pages the PDF holds (read by the text-layer check before). */
  readonly pdfPageCount?: number;
  readonly signal: AbortSignal;
}

/** PDF pages rasterized at a time: bounds the PNGs on the worker's /tmp (tmpfs in staging). */
export const PAGE_BATCH = 10;
/** Pages recognised at once, each Tesseract on one thread: more threads per page barely help (measured, D-139). */
const PARALLEL_PAGES = 2;
const DPI = '300';
/** `--psm 1`: page segmentation with orientation detection, so rotated scans are read upright. */
const TESSERACT_ARGS = ['-l', 'ara+eng', '--psm', '1', 'txt', 'tsv'];
const EXTENSION: Record<string, string> = {
  [OCR_MIME.PDF]: 'pdf',
  [OCR_MIME.JPEG]: 'jpg',
  [OCR_MIME.PNG]: 'png',
  [OCR_MIME.TIFF]: 'tiff',
};

interface Page {
  readonly text: string;
  readonly words: number;
  readonly confidenceSum: number;
}

/**
 * OCR of a scan or an image with the system's Tesseract (`ara+eng`) and, for PDFs, poppler's `pdftoppm` (D-139). Works in
 * a private temporary folder that is always removed; an abort (the attempt's timeout, D-084) kills the running process.
 * A missing binary or a failed run throws a plain error, so the queue retries and then marks the document EXT-002.
 */
export async function ocr(
  content: Buffer,
  mimeType: string,
  options: OcrOptions,
): Promise<OcrResult> {
  const folder = await mkdtemp(join(tmpdir(), 'nlq-ocr-'));
  try {
    const input = join(folder, `in.${EXTENSION[mimeType] ?? 'bin'}`);
    await writeFile(input, content);
    const pages =
      mimeType === OCR_MIME.PDF
        ? await pdfPages(
            input,
            folder,
            Math.min(options.pdfPageCount ?? 1, options.maxPages),
            options.signal,
          )
        : await recognise(input, join(folder, 'image'), options.signal);
    return result(pages);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** Rasterized and recognised PAGE_BATCH pages at a time; each batch's images are deleted before the next. */
async function pdfPages(
  input: string,
  folder: string,
  pages: number,
  signal: AbortSignal,
): Promise<Page[]> {
  const read: Page[] = [];
  for (let first = 1; first <= pages; first += PAGE_BATCH) {
    const last = Math.min(first + PAGE_BATCH - 1, pages);
    const prefix = join(folder, `b${first}`);
    await run(
      'pdftoppm',
      ['-r', DPI, '-gray', '-png', '-f', `${first}`, '-l', `${last}`, input, prefix],
      {
        signal,
      },
    );
    // pdftoppm pads page numbers to the document's width (b1-01.png): sorting the names keeps page order.
    const images = (await readdir(folder))
      .filter((name) => name.startsWith(`b${first}-`) && name.endsWith('.png'))
      .sort();
    for (let index = 0; index < images.length; index += PARALLEL_PAGES) {
      const group = images.slice(index, index + PARALLEL_PAGES);
      const results = await Promise.all(
        group.map((name) => recognise(join(folder, name), join(folder, `${name}.out`), signal)),
      );
      read.push(...results.flat());
      await Promise.all(group.map((name) => unlink(join(folder, name))));
    }
  }
  return read;
}

/** One Tesseract run: the text (pages separated by form feeds, as for a multi-page TIFF) and its word confidences. */
async function recognise(image: string, outBase: string, signal: AbortSignal): Promise<Page[]> {
  await run('tesseract', [image, outBase, ...TESSERACT_ARGS], {
    signal,
    // One thread per process: the worker's concurrency and PARALLEL_PAGES decide the CPU used.
    env: { ...process.env, OMP_THREAD_LIMIT: '1' },
  });
  const [text, tsv] = await Promise.all([
    readFile(`${outBase}.txt`, 'utf8'),
    readFile(`${outBase}.tsv`, 'utf8'),
  ]);
  const confidences = wordConfidences(tsv);
  // Tesseract ends every page with a form feed: the part after the last one is empty.
  const texts = text.split('\f');
  if (texts.length > 1 && !texts.at(-1)?.trim()) texts.pop();
  const count = Math.max(confidences.length, texts.length);
  return Array.from({ length: count }, (_, page) => ({
    text: (texts[page] ?? '').trim(),
    words: confidences[page]?.words ?? 0,
    confidenceSum: confidences[page]?.sum ?? 0,
  }));
}

/** Per page (TSV `page_num`, 1-based), the number and confidence sum of recognised words (level 5, conf ≥ 0). */
export function wordConfidences(tsv: string): { words: number; sum: number }[] {
  const pages: { words: number; sum: number }[] = [];
  for (const line of tsv.split('\n').slice(1)) {
    const cells = line.split('\t');
    const [level, pageNumber, conf, word] = [
      cells[0],
      Number(cells[1]),
      Number(cells[10]),
      cells[11],
    ];
    if (level !== '5' || !(conf >= 0) || !word?.trim() || !(pageNumber >= 1)) continue;
    const page = (pages[pageNumber - 1] ??= { words: 0, sum: 0 });
    page.words += 1;
    page.sum += conf;
  }
  return Array.from({ length: pages.length }, (_, index) => pages[index] ?? { words: 0, sum: 0 });
}

const round = (value: number): number => Math.round(value * 100) / 100;

function result(pages: readonly Page[]): OcrResult {
  const words = pages.reduce((total, page) => total + page.words, 0);
  const sum = pages.reduce((total, page) => total + page.confidenceSum, 0);
  return {
    text: clip(pages.map((page) => page.text).join('\n\f\n')),
    pageCount: pages.length,
    confidence: words ? round(sum / words) : null,
    pageConfidences: pages.map((page) =>
      page.words ? round(page.confidenceSum / page.words) : null,
    ),
  };
}
