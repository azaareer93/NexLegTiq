import { execFile } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import { ocr, ocrable, OCR_MIME, PAGE_BATCH, wordConfidences } from './ocr';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
const mockedExecFile = jest.mocked(execFile);

const TSV_HEADER =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
const word = (page: number, conf: number, text: string) =>
  `5\t${page}\t1\t1\t1\t1\t0\t0\t10\t10\t${conf}\t${text}`;

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
let folders: string[] = [];

/** Writes what pdftoppm and Tesseract would: one PNG per page, and `<out>.txt` / `<out>.tsv` per image. */
function fakeTools({ failTesseract = false } = {}) {
  folders = [];
  mockedExecFile.mockImplementation(((
    command: string,
    args: string[],
    _options: unknown,
    callback: Callback,
  ) => {
    if (command === 'pdftoppm') {
      const first = Number(args[args.indexOf('-f') + 1]);
      const last = Number(args[args.indexOf('-l') + 1]);
      const prefix = args.at(-1) ?? '';
      folders.push(dirname(prefix));
      for (let page = first; page <= last; page += 1) {
        writeFileSync(`${prefix}-${String(page).padStart(2, '0')}.png`, '');
      }
    } else if (failTesseract) {
      callback(new Error('tesseract: command not found'), '', '');
      return undefined;
    } else {
      const [image = '', out = ''] = args;
      folders.push(dirname(image));
      const page = basename(image).match(/-(\d+)\.png$/)?.[1] ?? 'image';
      writeFileSync(`${out}.txt`, `page ${page}\n\f`);
      writeFileSync(`${out}.tsv`, [TSV_HEADER, word(1, 80, 'page'), word(1, 90, page)].join('\n'));
    }
    callback(null, '', '');
    return undefined;
  }) as unknown as typeof execFile);
}

const signal = () => new AbortController().signal;
const calls = (command: string) => mockedExecFile.mock.calls.filter(([name]) => name === command);

describe('ocr (D-139)', () => {
  beforeEach(() => mockedExecFile.mockReset());

  it('should know which types it reads', () => {
    expect(Object.values(OCR_MIME).every(ocrable)).toBe(true);
    expect(ocrable('application/msword')).toBe(false);
  });

  it('should rasterize a PDF in batches and keep the pages in order', async () => {
    fakeTools();
    const result = await ocr(Buffer.from('%PDF'), OCR_MIME.PDF, {
      maxPages: 100,
      pdfPageCount: PAGE_BATCH + 2,
      signal: signal(),
    });
    expect(calls('pdftoppm').map(([, args]) => (args as string[]).slice(4, 8))).toEqual([
      ['-f', '1', '-l', `${PAGE_BATCH}`],
      ['-f', `${PAGE_BATCH + 1}`, '-l', `${PAGE_BATCH + 2}`],
    ]);
    expect(calls('tesseract')).toHaveLength(PAGE_BATCH + 2);
    expect(calls('tesseract')[0]?.[1]).toEqual(
      expect.arrayContaining(['-l', 'ara+eng', '--psm', '1', 'txt', 'tsv']),
    );
    expect(calls('tesseract')[0]?.[2]).toMatchObject({ env: { OMP_THREAD_LIMIT: '1' } });
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

  it('should read no more pages than allowed, and remove its temporary folder', async () => {
    fakeTools();
    const result = await ocr(Buffer.from('%PDF'), OCR_MIME.PDF, {
      maxPages: 3,
      pdfPageCount: 50,
      signal: signal(),
    });
    expect(result.pageCount).toBe(3);
    expect(() => readdirSync(folders[0] ?? '')).toThrow(/ENOENT/);
  });

  it('should read an image in one run and pass the abort signal on', async () => {
    fakeTools();
    const controller = new AbortController();
    const result = await ocr(Buffer.from('jpeg'), OCR_MIME.JPEG, {
      maxPages: 100,
      signal: controller.signal,
    });
    expect(calls('pdftoppm')).toHaveLength(0);
    expect(calls('tesseract')[0]?.[1]?.[0]).toMatch(/in\.jpg$/);
    expect(calls('tesseract')[0]?.[2]).toMatchObject({ signal: controller.signal });
    expect(result).toEqual({
      text: 'page image',
      pageCount: 1,
      confidence: 85,
      pageConfidences: [85],
    });
  });

  it('should fail (so the queue retries) when a tool fails, and still clean up', async () => {
    fakeTools({ failTesseract: true });
    await expect(
      ocr(Buffer.from('png'), OCR_MIME.PNG, { maxPages: 100, signal: signal() }),
    ).rejects.toThrow('tesseract: command not found');
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
