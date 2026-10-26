import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

export interface PdfDocument {
  readonly pageCount: number;
  /** Draws a page into the canvas at `width` CSS pixels (sharp on high-DPI screens); a newer call cancels an older one. */
  renderPage(page: number, canvas: HTMLCanvasElement, width: number): Promise<void>;
  destroy(): Promise<void>;
}

/** pdf.js's own default limit: a hostile page shape (1 × 14,400 pt) must not allocate a canvas that takes the tab down. */
export const MAX_CANVAS_PIXELS = 16_777_216;

const isCancelled = (error: unknown): boolean =>
  (error as { name?: string }).name === 'RenderingCancelledException';

/** Page drawing on one canvas where only the latest request draws: older ones stop at their next step or are cancelled. */
export function canvasRenderer(pdf: Pick<PDFDocumentProxy, 'getPage'>): PdfDocument['renderPage'] {
  let generation = 0;
  let running: RenderTask | null = null;
  return async (number, canvas, width) => {
    const mine = ++generation;
    running?.cancel();
    const page = await pdf.getPage(number);
    if (mine !== generation) return; // a newer page or width was asked for meanwhile
    const base = page.getViewport({ scale: 1 });
    const wanted = (width / base.width) * (window.devicePixelRatio || 1);
    const pixels = base.width * base.height * wanted * wanted;
    const scale =
      pixels > MAX_CANVAS_PIXELS ? wanted * Math.sqrt(MAX_CANVAS_PIXELS / pixels) : wanted;
    const viewport = page.getViewport({ scale });
    running?.cancel();
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${width}px`;
    const task = page.render({ canvas, viewport });
    running = task;
    try {
      await task.promise;
    } catch (error) {
      if (!isCancelled(error)) throw error; // replaced by a newer render: not a failure
    }
  };
}

/**
 * pdf.js, loaded on first use in its own chunk with its worker served from the app's assets (D-143: CSP `worker-src
 * 'self'`). The bytes come from the app's own fetch, never a URL pdf.js would load; XFA forms are not rendered. pdf.js 6
 * no longer compiles font code with `eval` (the CVE-2024-4367 path), so no option is needed for it.
 */
export async function openPdf(bytes: ArrayBuffer): Promise<PdfDocument> {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), enableXfa: false });
  const pdf: PDFDocumentProxy = await loading.promise;
  return {
    pageCount: pdf.numPages,
    renderPage: canvasRenderer(pdf),
    destroy: () => loading.destroy(),
  };
}
