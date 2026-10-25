import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

export interface PdfDocument {
  readonly pageCount: number;
  /** Draws a page into the canvas at `width` CSS pixels (sharp on high-DPI screens); a newer call cancels an older one. */
  renderPage(page: number, canvas: HTMLCanvasElement, width: number): Promise<void>;
  destroy(): Promise<void>;
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
  let running: RenderTask | null = null;
  return {
    pageCount: pdf.numPages,
    async renderPage(number, canvas, width) {
      running?.cancel();
      const page = await pdf.getPage(number);
      const scale = (width / page.getViewport({ scale: 1 }).width) * (window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${width}px`;
      const task = page.render({ canvas, viewport });
      running = task;
      try {
        await task.promise;
      } catch (error) {
        // A render replaced by a newer page is not a failure.
        if ((error as { name?: string }).name !== 'RenderingCancelledException') throw error;
      }
    },
    destroy: () => loading.destroy(),
  };
}
