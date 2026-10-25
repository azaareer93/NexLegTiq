import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Decimal } from 'decimal.js';

import { clip } from './extract-text';
import { OCR_MIME, PAGE_BATCH, tool } from './ocr';
import type { OcrResult } from './ocr';

export interface VisionConfig {
  readonly apiKey: string;
  readonly endpoint: string;
  readonly pricePer1000: number;
}

export interface VisionResult extends OcrResult {
  /** What the pages cost, in USD as a decimal string (`pricePer1000` × pages / 1000). */
  readonly costUsd: string;
}

/** A Google Vision failure, by its code only (`HTTP_503`, `VISION_8`, `NETWORK`): the provider's message is never kept. */
export class VisionError extends Error {
  constructor(readonly code: string) {
    super(`Google Vision failed: ${code}`);
    this.name = 'VisionError';
  }
}

/** Requests are JSON with base64 images (10 MB at most): an image larger than this is left to Tesseract. */
export const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
/** PDF pages are rasterized for Vision at 200 dpi (enough for DOCUMENT_TEXT_DETECTION), at most twice an A4 side. */
const DPI = '200';
const MAX_SIDE = '4678';
const PARALLEL_PAGES = 2;
const PER_REQUEST_MS = 30_000;

/**
 * Google Cloud Vision DOCUMENT_TEXT_DETECTION of a scan or an image (D-142): one page per request, two at a time, Arabic
 * and English hinted, the API key in the `x-goog-api-key` header (never the URL). PDFs are rasterized PAGE_BATCH pages
 * at a time like the Tesseract path; JPEG and PNG are sent as they are. Returns null for what Vision is not given here
 * (TIFF, an image over MAX_IMAGE_BYTES) so the Tesseract result stands.
 */
export async function visionOcr(
  content: Buffer,
  mimeType: string,
  options: { readonly pages: number; readonly signal: AbortSignal; readonly config: VisionConfig },
): Promise<VisionResult | null> {
  const { signal, config } = options;
  if (mimeType === OCR_MIME.JPEG || mimeType === OCR_MIME.PNG) {
    if (content.length > MAX_IMAGE_BYTES) return null;
    return result([await annotate(content, config, signal)], config);
  }
  if (mimeType !== OCR_MIME.PDF) return null;
  const folder = await mkdtemp(join(tmpdir(), 'nlq-vision-'));
  try {
    const input = join(folder, 'in.pdf');
    await writeFile(input, content);
    const pages: Page[] = [];
    for (let first = 1; first <= options.pages; first += PAGE_BATCH) {
      const last = Math.min(first + PAGE_BATCH - 1, options.pages);
      const prefix = join(folder, `b${first}`);
      await tool(
        'pdftoppm',
        [
          ...['-r', DPI, '-W', MAX_SIDE, '-H', MAX_SIDE, '-gray', '-jpeg'],
          ...['-f', `${first}`, '-l', `${last}`, input, prefix],
        ],
        signal,
      );
      const images = (await readdir(folder))
        .filter((name) => name.startsWith(`b${first}-`) && name.endsWith('.jpg'))
        .sort();
      for (let index = 0; index < images.length; index += PARALLEL_PAGES) {
        const group = images.slice(index, index + PARALLEL_PAGES);
        pages.push(
          ...(await Promise.all(
            group.map(async (name) => annotate(await readFile(join(folder, name)), config, signal)),
          )),
        );
        await Promise.all(group.map((name) => unlink(join(folder, name))));
      }
    }
    return result(pages, config);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

interface Page {
  readonly text: string;
  /** 0–100; null for a page without text. */
  readonly confidence: number | null;
}

interface AnnotateResponse {
  responses?: {
    error?: { code?: number };
    fullTextAnnotation?: { text?: string; pages?: { confidence?: number }[] };
  }[];
}

async function annotate(image: Buffer, config: VisionConfig, signal: AbortSignal): Promise<Page> {
  let response: Response;
  try {
    response = await fetch(`${config.endpoint}/v1/images:annotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: JSON.stringify({
        requests: [
          {
            image: { content: image.toString('base64') },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            imageContext: { languageHints: ['ar', 'en'] },
          },
        ],
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(PER_REQUEST_MS)]),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new VisionError('NETWORK');
  }
  if (!response.ok) throw new VisionError(`HTTP_${response.status}`);
  return parse((await response.json().catch(() => ({}))) as AnnotateResponse);
}

/** One page's text and mean confidence (0–100) from Vision's answer; its errors by code only. */
function parse(body: AnnotateResponse): Page {
  const answer = body.responses?.[0];
  if (!answer) throw new VisionError('EMPTY_RESPONSE');
  if (answer.error) throw new VisionError(`VISION_${answer.error.code ?? 'UNKNOWN'}`);
  const annotation = answer.fullTextAnnotation ?? {};
  const text = annotation.text?.trim() ?? '';
  return { text, confidence: text ? meanConfidence(annotation.pages ?? []) : null };
}

/** Vision's per-page confidences (0–1) averaged as 0–100; null when it gave none. */
function meanConfidence(pages: readonly { confidence?: number }[]): number | null {
  const values = pages
    .map((page) => page.confidence)
    .filter((value): value is number => typeof value === 'number');
  return values.length
    ? (values.reduce((sum, value) => sum + value, 0) / values.length) * 100
    : null;
}

const round = (value: number): number => Math.round(value * 100) / 100;

function result(pages: readonly Page[], config: VisionConfig): VisionResult {
  const read = pages.filter((page) => page.confidence !== null);
  return {
    text: clip(pages.map((page) => page.text).join('\n\f\n')),
    pageCount: pages.length,
    confidence: read.length
      ? round(read.reduce((sum, page) => sum + (page.confidence ?? 0), 0) / read.length)
      : null,
    pageConfidences: pages.map((page) =>
      page.confidence === null ? null : round(page.confidence),
    ),
    // Money is never a float (D-017): decimal.js, six places like the column (Decimal(10, 6)).
    costUsd: new Decimal(config.pricePer1000).times(pages.length).div(1000).toFixed(6),
  };
}
