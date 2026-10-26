import type { Document } from '@nexlegtiq/shared-contracts';
import { EmptyState, LoadingSkeleton } from '@nexlegtiq/shared-ui';
import { Flex, Input, Pagination, Typography } from 'antd';
import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { QueryError } from './QueryError';
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
 * marked. Each paragraph takes its own direction from its first strong letter (`unicode-bidi: plaintext`) and aligns to
 * its own start, so Arabic reads right to left and English left to right whatever the interface language. The drawer
 * mounts it per version, so a new version starts again on page 1.
 */
export function TextPane({ document }: { readonly document: Document }): React.JSX.Element {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const text = useDocumentText(document, page);
  const segments = useMemo(() => highlight(text.data?.text ?? '', query), [text.data, query]);
  const matches = segments.filter((segment) => segment.match).length;
  if (text.isError) return <QueryError error={text.error} onRetry={() => void text.refetch()} />;
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
        style={{
          whiteSpace: 'pre-wrap',
          unicodeBidi: 'plaintext',
          textAlign: 'start',
          lineHeight: 1.9,
        }}
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
        <nav aria-label={t('documents.preview.textPages')}>
          <Pagination
            simple
            current={page}
            total={text.data.totalPages}
            pageSize={1}
            onChange={setPage}
            data-testid="document-text-pages"
          />
        </nav>
      ) : null}
    </Flex>
  );
}
