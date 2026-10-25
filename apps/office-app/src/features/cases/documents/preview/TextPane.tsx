import type { Document } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import { EmptyState, ErrorState, LoadingSkeleton } from '@nexlegtiq/shared-ui';
import { Flex, Input, Pagination, Typography } from 'antd';
import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDocumentText } from './use-document-preview';

export interface Segment {
  readonly text: string;
  readonly match: boolean;
}

/** The text cut around every case-insensitive occurrence of `query` (regex characters taken literally). */
export function highlight(text: string, query: string): Segment[] {
  const needle = query.trim();
  if (!needle) return [{ text, match: false }];
  const pattern = new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'iu');
  // Split with one capturing group: the matches are the odd parts.
  return text
    .split(pattern)
    .map((part, index) => ({ text: part, match: index % 2 === 1 }))
    .filter((segment) => segment.text !== '');
}

/**
 * The Text tab (D-143): the current version's extracted text, 20,000 characters a page (D-128), with the page's matches
 * marked. Each paragraph takes its own direction from its first strong letter (`unicode-bidi: plaintext`), so Arabic
 * reads right to left and English left to right whatever the interface language.
 */
export function TextPane({
  fileId,
  document,
}: {
  readonly fileId: string;
  readonly document: Document;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const text = useDocumentText(fileId, document, page);
  const segments = useMemo(() => highlight(text.data?.text ?? '', query), [text.data, query]);
  const matches = segments.filter((segment) => segment.match).length;
  if (text.isError) {
    const { code, requestId } = text.error as { code?: string; requestId?: string };
    return (
      <ErrorState
        code={code && isErrorCode(code) ? code : undefined}
        requestId={requestId}
        onRetry={() => void text.refetch()}
      />
    );
  }
  if (!text.data) return <LoadingSkeleton rows={6} />;
  if (text.data.totalPages === 0) {
    return (
      <EmptyState
        title={t(
          text.data.ocrStatus === 'PENDING'
            ? 'documents.preview.textPending'
            : 'documents.preview.textNone',
        )}
      />
    );
  }
  return (
    <Flex vertical gap={12}>
      <Flex gap={12} align="center" wrap>
        <Input.Search
          allowClear
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('documents.preview.search')}
          aria-label={t('documents.preview.search')}
          style={{ maxInlineSize: 320 }}
          data-testid="document-text-search"
        />
        {query.trim() ? (
          <Typography.Text type="secondary" role="status" data-testid="document-text-matches">
            {t('documents.preview.matches', { count: matches })}
          </Typography.Text>
        ) : null}
      </Flex>
      <div
        dir="auto"
        style={{ whiteSpace: 'pre-wrap', unicodeBidi: 'plaintext', lineHeight: 1.9 }}
        data-testid="document-text"
      >
        {segments.map((segment, index) =>
          segment.match ? (
            <mark key={index}>{segment.text}</mark>
          ) : (
            <Fragment key={index}>{segment.text}</Fragment>
          ),
        )}
      </div>
      {text.data.totalPages > 1 ? (
        <Pagination
          simple
          current={page}
          total={text.data.totalPages}
          pageSize={1}
          onChange={setPage}
          data-testid="document-text-pages"
        />
      ) : null}
    </Flex>
  );
}
