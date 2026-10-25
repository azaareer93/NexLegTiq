import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { OCR_MIME } from './ocr';
import { MAX_IMAGE_BYTES, VisionError, visionOcr } from './vision';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
const mockedExecFile = jest.mocked(execFile);

const config = {
  apiKey: 'vision-test-key',
  endpoint: 'https://eu-vision.googleapis.com',
  pricePer1000: 1.5,
};
const signal = () => new AbortController().signal;

const answer = (text: string, confidence = 0.9) =>
  new Response(
    JSON.stringify({ responses: [{ fullTextAnnotation: { text, pages: [{ confidence }] } }] }),
    { status: 200 },
  );

describe('visionOcr (D-142)', () => {
  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
    mockedExecFile.mockReset();
  });
  afterEach(() => fetchMock.mockRestore());

  it('should send an image for document text detection with the key in a header, never the URL', async () => {
    fetchMock.mockResolvedValueOnce(answer('محكمة بداية رام الله\n', 0.93));
    const result = await visionOcr(Buffer.from('png-bytes'), OCR_MIME.PNG, {
      pages: 1,
      signal: signal(),
      config,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://eu-vision.googleapis.com/v1/images:annotate');
    expect(url).not.toContain('vision-test-key');
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'vision-test-key' });
    expect(JSON.parse(init.body as string)).toEqual({
      requests: [
        {
          image: { content: Buffer.from('png-bytes').toString('base64') },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
          imageContext: { languageHints: ['ar', 'en'] },
        },
      ],
    });
    expect(result).toEqual({
      text: 'محكمة بداية رام الله',
      pageCount: 1,
      confidence: 93,
      pageConfidences: [93],
      costUsd: '0.001500',
    });
  });

  it('should read a PDF page by page, in order, and price every page', async () => {
    mockedExecFile.mockImplementation(((
      _command: string,
      args: string[],
      _options: unknown,
      callback: (error: null, stdout: string, stderr: string) => void,
    ) => {
      const prefix = args.at(-1) ?? '';
      writeFileSync(`${prefix}-1.jpg`, 'page-1');
      writeFileSync(`${prefix}-2.jpg`, 'page-2');
      callback(null, '', '');
      return undefined;
    }) as unknown as typeof execFile);
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as {
        requests: { image: { content: string } }[];
      };
      const page = Buffer.from(body.requests[0]?.image.content ?? '', 'base64').toString();
      return answer(page === 'page-1' ? 'first' : '', 0.8);
    });
    const result = await visionOcr(Buffer.from('%PDF'), OCR_MIME.PDF, {
      pages: 2,
      signal: signal(),
      config,
    });
    expect(mockedExecFile.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['-r', '200', '-gray', '-jpeg', '-f', '1', '-l', '2']),
    );
    expect(result).toMatchObject({
      text: 'first\n\f\n',
      pageCount: 2,
      confidence: 80,
      pageConfidences: [80, null],
      costUsd: '0.003000',
    });
  });

  it('should leave TIFF and oversized images to Tesseract', async () => {
    await expect(
      visionOcr(Buffer.from('tiff'), OCR_MIME.TIFF, { pages: 1, signal: signal(), config }),
    ).resolves.toBeNull();
    await expect(
      visionOcr(Buffer.alloc(MAX_IMAGE_BYTES + 1), OCR_MIME.JPEG, {
        pages: 1,
        signal: signal(),
        config,
      }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should fail with the provider code only: HTTP status, Vision error, network, empty answer', async () => {
    const run = () =>
      visionOcr(Buffer.from('x'), OCR_MIME.PNG, { pages: 1, signal: signal(), config });
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":{"message":"quota for user@example.com"}}', { status: 429 }),
    );
    await expect(run()).rejects.toEqual(new VisionError('HTTP_429'));
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ responses: [{ error: { code: 3, message: 'bad image' } }] })),
    );
    await expect(run()).rejects.toMatchObject({ code: 'VISION_3' });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(run()).rejects.toMatchObject({ code: 'NETWORK' });
    fetchMock.mockResolvedValueOnce(new Response('{}'));
    await expect(run()).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' });
  });

  it('should pass an abort through instead of calling it a provider failure', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(
      visionOcr(Buffer.from('x'), OCR_MIME.PNG, { pages: 1, signal: controller.signal, config }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
