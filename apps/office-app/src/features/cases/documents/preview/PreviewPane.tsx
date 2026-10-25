import type { Document } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import { EmptyState, ErrorState, LoadingSkeleton } from '@nexlegtiq/shared-ui';
import { Flex, Pagination } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { openPdf } from './pdf-render';
import type { PdfDocument } from './pdf-render';
import { previewKind, useDocumentBytes } from './use-document-preview';

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

/** One page at a time on a canvas, at the drawer's width; a page that cannot be drawn says so. */
function PdfViewer({ blob }: { readonly blob: Blob }): React.JSX.Element {
  const { t } = useTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PdfDocument | null>(null);
  const [page, setPage] = useState(1);
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
  useEffect(() => {
    const target = canvas.current;
    if (!pdf || !target) return;
    const width = Math.max(320, target.parentElement?.clientWidth ?? 800);
    pdf.renderPage(page, target, width).catch(() => setFailed(true));
  }, [pdf, page]);
  if (failed) return <EmptyState title={t('documents.preview.failed')} />;
  if (!pdf) return <LoadingSkeleton rows={6} />;
  return (
    <Flex vertical gap={12} align="center" data-testid="document-preview-pdf">
      {pdf.pageCount > 1 ? (
        <Pagination
          simple
          current={page}
          total={pdf.pageCount}
          pageSize={1}
          onChange={setPage}
          data-testid="document-preview-pages"
        />
      ) : null}
      <div style={{ inlineSize: '100%', overflow: 'auto' }}>
        <canvas
          ref={canvas}
          role="img"
          aria-label={t('documents.preview.pageOf', { page, total: pdf.pageCount })}
        />
      </div>
    </Flex>
  );
}

/**
 * The Preview tab (D-143): PDFs through pdf.js, PNG and JPEG as images, from bytes the app fetched itself; any other
 * type points to the Text tab and the download. A document not yet scanned clean gets the API's own error (BIZ-015 /
 * STO-004, D-128).
 */
export function PreviewPane({ document }: { readonly document: Document }): React.JSX.Element {
  const { t } = useTranslation();
  const kind = previewKind(document.mimeType);
  const bytes = useDocumentBytes(document, kind !== null);
  const url = useObjectUrl(kind === 'image' ? bytes.data : undefined);
  if (!kind) {
    return (
      <EmptyState
        title={t('documents.preview.unsupported')}
        description={t('documents.preview.unsupportedHint')}
      />
    );
  }
  if (bytes.isError) {
    const { code, requestId } = bytes.error as { code?: string; requestId?: string };
    return (
      <ErrorState
        code={code && isErrorCode(code) ? code : undefined}
        requestId={requestId}
        onRetry={() => void bytes.refetch()}
      />
    );
  }
  if (!bytes.data) return <LoadingSkeleton rows={6} />;
  if (kind === 'pdf') return <PdfViewer blob={bytes.data} />;
  return url ? (
    <img
      src={url}
      alt={document.name}
      style={{ maxInlineSize: '100%', display: 'block', marginInline: 'auto' }}
      data-testid="document-preview-image"
    />
  ) : (
    <LoadingSkeleton rows={6} />
  );
}
