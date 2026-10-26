import { execFile } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { UnreadableDocumentError } from './extract-text';
import { jpegHeader, pngHeader, tiffHeader } from './fixtures.test-helper';
import { ocr, ocrable, OCR_MIME, PAGE_BATCH, wordConfidences } from './ocr';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
const mockedExecFile = jest.mocked(execFile);

const TSV_HEADER =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const word = (page: number, conf: number, text: string) =>
  `5\t${page}\t1\t1\t1\t1\t0\t0\t10\t10\t${conf}\t${text}`;

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
type Options = { signal: AbortSignal; env: Record<string, string> };
let folders: string[] = [];

interface Fake {
  /** Tesseract fails with this stderr. */
  readonly stderr?: string;
  /** Tesseract never answers until its signal aborts. */
  readonly hangOn?: RegExp;
  /** Tesseract of a TIFF writes this many pages. */
  readonly tiffPages?: number;
  /** Tesseract finds no word (a blank page). */
  readonly blank?: boolean;
}

/** pdftoppm: one empty PNG per page of the batch, named as poppler names them. */
function fakePdftoppm(args: string[], callback: Callback): void {
  const first = Number(args[args.indexOf('-f') + 1]);
  const last = Number(args[args.indexOf('-l') + 1]);
  const prefix = args.at(-1) ?? '';
  folders.push(dirname(prefix));
  for (let page = first; page <= last; page += 1) {
    writeFileSync(`${prefix}-${String(page).padStart(2, '0')}.png`, '');
  }
  callback(null, '', '');
}

/** Tesseract: `<out>.txt` (pages ended by form feeds) and `<out>.tsv`, or the failure the fake asks for. */
function fakeTesseract(fake: Fake, args: string[], options: Options, callback: Callback): void {
  const [image = '', out = ''] = args;
  folders.push(dirname(image));
  if (fake.hangOn?.test(image)) {
    options.signal.addEventListener('abort', () =>
      callback(Object.assign(new Error('aborted'), { name: 'AbortError' }), '', ''),
    );
    return;
  }
  if (fake.stderr !== undefined) {
    const error = Object.assign(new Error('Command failed'), { stderr: fake.stderr });
    callback(error, '', fake.stderr);
    return;
  }
  writeOutput(fake, image, out);
  callback(null, '', '');
}

/** "page <n>" per page (the PNG's page number, or the TIFF page), each word at confidence 80 and 90; nothing when blank. */
function writeOutput(fake: Fake, image: string, out: string): void {
  const page = basename(image).match(/-(\d+)\.png$/)?.[1] ?? 'image';
  const pages = image.endsWith('.tiff') ? (fake.tiffPages ?? 1) : 1;
  const numbers = fake.blank ? [] : Array.from({ length: pages }, (_, index) => index + 1);
  const label = (n: number) => (pages > 1 ? `${n}` : page);
  writeFileSync(`${out}.txt`, numbers.map((n) => `page ${label(n)}\n\f`).join('') || '\f');
  const words = numbers.flatMap((n) => [word(n, 80, 'page'), word(n, 90, label(n))]);
  writeFileSync(`${out}.tsv`, [TSV_HEADER, ...words].join('\n'));
}

/** Writes what pdftoppm and Tesseract would: one PNG per page, and `<out>.txt` / `<out>.tsv` per image. */
function fakeTools(fake: Fake = {}) {
  folders = [];
  mockedExecFile.mockImplementation(((
    command: string,
    args: string[],
    options: Options,
    callback: Callback,
  ) => {
    if (command === 'pdftoppm') fakePdftoppm(args, callback);
    else fakeTesseract(fake, args, options, callback);
    return undefined;
  }) as unknown as typeof execFile);
}

const signal = () => new AbortController().signal;
const calls = (command: string) => mockedExecFile.mock.calls.filter(([name]) => name === command);
const options = (call: unknown[] | undefined) => call?.[2] as Options | undefined;

describe('ocr (D-139)', () => {
  beforeEach(() => mockedExecFile.mockReset());

  it('should know which types it reads', () => {
    expect(Object.values(OCR_MIME).every(ocrable)).toBe(true);
    expect(ocrable('application/msword')).toBe(false);
  });

  it('should rasterize a PDF in capped-size batches and keep the pages in order', async () => {
    fakeTools();
    const result = await ocr(Buffer.from('%PDF'), OCR_MIME.PDF, {
      maxPages: 100,
      pdfPageCount: PAGE_BATCH + 2,
      signal: signal(),
    });
    expect(calls('pdftoppm').map(([, args]) => (args as string[]).slice(0, 12))).toEqual([
      ['-r', '300', '-W', '7016', '-H', '7016', '-gray', '-png', '-f', '1', '-l', `${PAGE_BATCH}`],
      [
        '-r',
        '300',
        '-W',
        '7016',
        '-H',
        '7016',
        '-gray',
        '-png',
        '-f',
        `${PAGE_BATCH + 1}`,
        '-l',
        `${PAGE_BATCH + 2}`,
      ],
    ]);
    expect(calls('tesseract')).toHaveLength(PAGE_BATCH + 2);
    expect(calls('tesseract')[0]?.[1]).toEqual(
      expect.arrayContaining(['-l', 'ara+eng', '--psm', '1', 'txt', 'tsv']),
    );
    expect(result.pageCount).toBe(PAGE_BATCH + 2);
    expect(result.text.split('\n\f\n')).toEqual(
      Array.from(
        { length: PAGE_BATCH + 2 },
        (_, page) => `page ${String(page + 1).padStart(2, '0')}`,
      ),
    );
    expect(result.confidence).toBe(85);
    expect(result.pageConfidences).toEqual(Array(PAGE_BATCH + 2).fill(85));
  });

  it('should give the tools no server secrets and one thread', async () => {
    fakeTools();
    process.env['JWT_SECRET_PROBE'] = 'secret';
    try {
      await ocr(Buffer.from('%PDF'), OCR_MIME.PDF, {
        maxPages: 5,
        pdfPageCount: 1,
        signal: signal(),
      });
    } finally {
      delete process.env['JWT_SECRET_PROBE'];
    }
    for (const call of mockedExecFile.mock.calls) {
      expect(Object.keys(options(call)?.env ?? {}).sort()).toEqual(
        expect.arrayContaining(['OMP_THREAD_LIMIT', 'PATH']),
      );
      expect(options(call)?.env).not.toHaveProperty('JWT_SECRET_PROBE');
      expect(options(call)?.env).toMatchObject({ OMP_THREAD_LIMIT: '1' });
    }
  });

  it('should read no more pages than allowed, a PDF without pages as empty, and remove its folder', async () => {
    fakeTools();
    const capped = await ocr(Buffer.from('%PDF'), OCR_MIME.PDF, {
      maxPages: 3,
      pdfPageCount: 50,
      signal: signal(),
    });
    expect(capped.pageCount).toBe(3);
    expect(existsSync(folders[0] ?? '')).toBe(false);
    mockedExecFile.mockClear();
    const empty = await ocr(Buffer.from('%PDF'), OCR_MIME.PDF, { maxPages: 3, signal: signal() });
    expect(empty).toEqual({ text: '', pageCount: 0, confidence: null, pageConfidences: [] });
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('should read an image in one run, and every page of a multi-page TIFF', async () => {
    fakeTools({ tiffPages: 2 });
    const image = await ocr(jpegHeader(1141, 536), OCR_MIME.JPEG, {
      maxPages: 50,
      signal: signal(),
    });
    expect(calls('pdftoppm')).toHaveLength(0);
    expect(calls('tesseract')[0]?.[1]?.[0]).toMatch(/in\.jpg$/);
    expect(image).toEqual({
      text: 'page image',
      pageCount: 1,
      confidence: 85,
      pageConfidences: [85],
    });
    const tiff = await ocr(tiffHeader(1000, 1000, 2), OCR_MIME.TIFF, {
      maxPages: 50,
      signal: signal(),
    });
    expect(tiff).toMatchObject({
      text: 'page 1\n\f\npage 2',
      pageCount: 2,
      pageConfidences: [85, 85],
    });
  });

  it('should give a blank page empty text and no confidence', async () => {
    fakeTools({ blank: true });
    await expect(
      ocr(pngHeader(800, 600), OCR_MIME.PNG, { maxPages: 50, signal: signal() }),
    ).resolves.toEqual({ text: '', pageCount: 1, confidence: null, pageConfidences: [null] });
  });

  it('should refuse a pixel bomb before running anything', async () => {
    fakeTools();
    await expect(
      ocr(pngHeader(40_000, 40_000), OCR_MIME.PNG, { maxPages: 50, signal: signal() }),
    ).rejects.toThrow(UnreadableDocumentError);
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('should call undecodable input unreadable (no retry) and other failures plain errors (retried)', async () => {
    fakeTools({ stderr: 'Error in pixReadStream: Unknown format: no pix returned' });
    await expect(
      ocr(pngHeader(800, 600), OCR_MIME.PNG, { maxPages: 50, signal: signal() }),
    ).rejects.toThrow(UnreadableDocumentError);
    fakeTools({ stderr: 'tesseract: command not found' });
    const failure = ocr(pngHeader(800, 600), OCR_MIME.PNG, { maxPages: 50, signal: signal() });
    await expect(failure).rejects.toThrow('Command failed');
    await expect(failure).rejects.not.toThrow(UnreadableDocumentError);
    expect(existsSync(folders[0] ?? '')).toBe(false);
  });

  it('should stop the running tools and clean up when the attempt is aborted', async () => {
    fakeTools({ hangOn: /\.png$/ });
    const controller = new AbortController();
    const running = ocr(Buffer.from('%PDF'), OCR_MIME.PDF, {
      maxPages: 5,
      pdfPageCount: 2,
      signal: controller.signal,
    });
    // Wait until both pages are being read (a fixed sleep was too short when the whole suite runs in parallel).
    for (let tries = 0; tries < 200 && calls('tesseract').length < 2; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(calls('tesseract')).toHaveLength(2);
    controller.abort();
    await expect(running).rejects.toThrow('aborted');
    expect(existsSync(folders[0] ?? '')).toBe(false);
  });

  it('should stop the sibling page when one page fails', async () => {
    fakeTools({ hangOn: /-02\.png$/ });
    let siblingAborted = false;
    const fake = mockedExecFile.getMockImplementation();
    mockedExecFile.mockImplementation(((
      command: string,
      args: string[],
      opts: Options,
      cb: Callback,
    ) => {
      if (command === 'tesseract' && /-01\.png$/.test(args[0] ?? '')) {
        cb(Object.assign(new Error('crashed'), { stderr: 'Segmentation fault' }), '', '');
        return undefined;
      }
      if (command === 'tesseract') {
        opts.signal.addEventListener('abort', () => {
          siblingAborted = true;
        });
      }
      return (fake as unknown as (...a: unknown[]) => unknown)(command, args, opts, cb);
    }) as unknown as typeof execFile);
    await expect(
      ocr(Buffer.from('%PDF'), OCR_MIME.PDF, { maxPages: 5, pdfPageCount: 2, signal: signal() }),
    ).rejects.toThrow('crashed');
    expect(siblingAborted).toBe(true);
  });
});

describe('wordConfidences', () => {
  it('should average recognised words per page and skip blocks, empty words and -1', () => {
    const tsv = [
      TSV_HEADER,
      '1\t1\t0\t0\t0\t0\t0\t0\t100\t100\t-1\t',
      word(1, 70, 'عقد'),
      word(1, -1, 'x'),
      word(1, 50, ' '),
      word(3, 90, 'Lease'),
      '',
    ].join('\n');
    expect(wordConfidences(tsv)).toEqual([
      { words: 1, sum: 70 },
      { words: 0, sum: 0 },
      { words: 1, sum: 90 },
    ]);
  });
});
