import type { Document } from '@nexlegtiq/shared-contracts';
import { EmptyState, LoadingSkeleton, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Flex, Pagination } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { openPdf } from './pdf-render';
import type { PdfDocument } from './pdf-render';
import { QueryError } from './QueryError';
import { openable, previewKind, useDocumentBytes } from './use-document-preview';

/** An object URL for the bytes while they are shown, revoked afterwards. */
function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return undefined;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

/** The element's width, kept up to date (the drawer opens with an animation and can be resized). */
function useWidth(element: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const target = element.current;
    if (!target) return undefined;
    setWidth(target.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

/** The PDF opened from the bytes, closed again when they change or the pane goes away. */
function usePdf(blob: Blob): { pdf: PdfDocument | null; failed: boolean; fail: () => void } {
  const [pdf, setPdf] = useState<PdfDocument | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let open: PdfDocument | null = null;
    let live = true;
    void blob
      .arrayBuffer()
      .then(openPdf)
      .then((doc) => {
        open = doc;
        if (live) setPdf(doc);
        else void doc.destroy();
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      void open?.destroy();
    };
  }, [blob]);
  const fail = useCallback(() => setFailed(true), []);
  return { pdf, failed, fail };
}

/** One page at a time on a canvas at the pane's width (redrawn when it changes); a page that cannot be drawn says so. */
function PdfViewer({ blob }: { readonly blob: Blob }): React.JSX.Element {
  const { t } = useTranslation();
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = useWidth(frame);
  const { pdf, failed, fail } = usePdf(blob);
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (!pdf || !canvas.current || width <= 0) return;
    pdf.renderPage(page, canvas.current, width).catch(fail);
  }, [pdf, page, width, fail]);
  if (failed) return <EmptyState title={t('documents.preview.failed')} />;
  return (
    <Flex vertical gap={12} align="center" data-testid="document-preview-pdf">
      {pdf && pdf.pageCount > 1 ? (
        <nav aria-label={t('documents.preview.pages')}>
          <Pagination
            simple
            current={page}
            total={pdf.pageCount}
            pageSize={1}
            onChange={setPage}
            data-testid="document-preview-pages"
          />
        </nav>
      ) : null}
      <div ref={frame} style={{ inlineSize: '100%', overflow: 'auto' }}>
        {pdf ? (
          <canvas
            ref={canvas}
            role="img"
            aria-label={t('documents.preview.pageOf', { page, total: pdf.pageCount })}
          />
        ) : (
          <LoadingSkeleton rows={6} />
        )}
      </div>
    </Flex>
  );
}

/**
 * The Preview tab (D-143): PDFs through pdf.js, PNG and JPEG as images, from bytes the app fetched itself; any other
 * type points to the Text tab and the download. The bytes are asked for only once the document was scanned clean — the
 * drawer's document refreshes on `document.processed`, so the preview appears by itself (D-128).
 */
export function PreviewPane({ document }: { readonly document: Document }): React.JSX.Element {
  const { t } = useTranslation();
  const { messageOf } = useApiErrorHandler();
  const kind = previewKind(document.mimeType);
  const ready = openable(document);
  const bytes = useDocumentBytes(document, kind !== null && ready);
  const url = useObjectUrl(kind === 'image' ? bytes.data : undefined);
  if (!kind) {
    return (
      <EmptyState
        title={t('documents.preview.unsupported')}
        description={t('documents.preview.unsupportedHint')}
      />
    );
  }
  if (!ready) {
    const code = document.status === 'QUARANTINED' ? 'STO-004' : 'BIZ-015';
    return <EmptyState title={messageOf({ code })} />;
  }
  if (bytes.isError) return <QueryError error={bytes.error} onRetry={() => void bytes.refetch()} />;
  if (!bytes.data) return <LoadingSkeleton rows={6} />;
  if (kind === 'pdf') return <PdfViewer blob={bytes.data} />;
  return url ? (
    <img
      src={url}
      alt={isolate(document.name)}
      style={{ maxInlineSize: '100%', display: 'block', marginInline: 'auto' }}
      data-testid="document-preview-image"
    />
  ) : (
    <LoadingSkeleton rows={6} />
  );
}
