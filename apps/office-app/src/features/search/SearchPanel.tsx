import { HistoryOutlined, SearchOutlined } from '@ant-design/icons';
import type { SearchResults, SearchType } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, Bdi, EmptyState } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Flex, Input, Spin, Typography, theme } from 'antd';
import type { TFunction } from 'i18next';
import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useSession } from '../auth';
import type { SearchGroup, SearchItem } from './search-items';
import { ActionText, resultGroups } from './search-items';
import { MIN_QUERY, recentFor, rememberSearch, useRecentSearches, useSearch } from './use-search';
import { useDebounced } from '../clients/list-params';

/** Read by screen readers, not shown. */
const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  inlineSize: 1,
  blockSize: 1,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

interface GroupInput {
  readonly searching: boolean;
  readonly data: SearchResults | undefined;
  readonly recent: readonly string[];
  readonly expanded: SearchType | null;
  readonly setText: (q: string) => void;
  readonly setExpanded: (type: SearchType | null) => void;
}

/** Before a query: the recent searches; then the results, or one type in full with a way back. */
function buildGroups(input: GroupInput, t: TFunction): SearchGroup[] {
  const { searching, data, recent, expanded, setText, setExpanded } = input;
  if (!searching) {
    const items = recent.map((saved) => ({
      key: `recent-${saved}`,
      icon: <HistoryOutlined />,
      onPick: () => setText(saved),
      content: <Bdi>{saved}</Bdi>,
    }));
    return items.length ? [{ key: 'recent', title: t('shell.search.recent'), items }] : [];
  }
  if (!data) return [];
  const found = resultGroups(data, t, expanded ? null : setExpanded);
  if (!expanded) return found;
  const back = {
    key: 'back',
    onPick: () => setExpanded(null),
    content: <ActionText>{t('shell.search.back')}</ActionText>,
  };
  return [{ key: 'back', title: '', items: [back] }, ...found];
}

const STEP: Readonly<Record<string, number>> = { ArrowDown: 1, ArrowUp: -1 };

function ResultList({
  id,
  groups,
  activeKey,
  onHover,
  onPick,
}: {
  readonly id: string;
  readonly groups: readonly SearchGroup[];
  readonly activeKey: string | undefined;
  readonly onHover: (item: SearchItem) => void;
  readonly onPick: (item: SearchItem) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  return (
    <div
      id={id}
      role="listbox"
      aria-label={t('shell.search.resultsLabel')}
      style={{ maxBlockSize: '60vh', overflowY: 'auto' }}
      data-testid="search-results"
    >
      {groups.map((group) => (
        <div key={group.key} role="group" aria-label={group.title || undefined}>
          {group.title ? (
            <Typography.Text strong style={{ display: 'block', paddingBlock: token.paddingXXS }}>
              {group.title}
            </Typography.Text>
          ) : null}
          {group.items.map((item) => (
            <div
              key={item.key}
              id={`${id}-${item.key}`}
              role="option"
              aria-selected={item.key === activeKey}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onHover(item)}
              onClick={() => onPick(item)}
              data-testid={`search-option-${item.key}`}
              style={{
                cursor: 'pointer',
                paddingBlock: token.paddingXS,
                paddingInline: token.paddingSM,
                borderRadius: token.borderRadius,
                background: item.key === activeKey ? token.controlItemBgActive : undefined,
              }}
            >
              <Flex gap={token.marginXS} align="baseline">
                {item.icon ? <span aria-hidden>{item.icon}</span> : null}
                <span style={{ minInlineSize: 0 }}>{item.content}</span>
              </Flex>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** The hint, the error, "nothing found" and the result count for screen readers. */
function SearchFeedback({
  q,
  searching,
  loaded,
  count,
  error,
}: {
  readonly q: string;
  readonly searching: boolean;
  readonly loaded: boolean;
  readonly count: number;
  readonly error: unknown;
}): React.JSX.Element {
  const { t } = useTranslation();
  const noResults = t('shell.search.noResults', { q: isolate(q) });
  return (
    <>
      <div role="status" style={SR_ONLY} data-testid="search-status">
        {loaded ? (count ? t('shell.search.results', { count }) : noResults) : ''}
      </div>
      {searching ? (
        <ApiErrorAlert error={error} testId="search-error" />
      ) : (
        <Typography.Text type="secondary">{t('shell.search.minChars')}</Typography.Text>
      )}
      {loaded && count === 0 ? <EmptyState description={noResults} /> : null}
    </>
  );
}

/** The office-wide search (D-167, D-172): grouped results, arrow keys + Enter, Escape closes the overlay. */
export function SearchPanel({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const listId = useId();
  const userId = useSession((s) => s.user?.id);
  const recent = useRecentSearches((s) => recentFor(s, userId));
  const [text, setText] = useState('');
  const [expanded, setExpanded] = useState<SearchType | null>(null);
  const [active, setActive] = useState(0);
  const q = useDebounced(text.trim());
  const searching = q.length >= MIN_QUERY;
  const query = useSearch(q, expanded);
  const data = searching ? query.data : undefined;

  const groups = useMemo(
    () => buildGroups({ searching, data, recent, expanded, setText, setExpanded }, t),
    [searching, data, recent, expanded, t],
  );
  const options = groups.flatMap((group) => group.items);
  const count = options.filter((item) => item.href).length;
  useEffect(() => setActive(0), [q, expanded, data]);

  const pick = (item: SearchItem | undefined) => {
    if (item?.onPick) return item.onPick();
    if (!item?.href) return;
    if (userId) rememberSearch(userId, q);
    onClose();
    void navigate(item.href);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = STEP[event.key];
    // Enter while the debounce is pending would open a result of the previous query.
    const enter = event.key === 'Enter' && text.trim() === q;
    if (options.length === 0 || (step === undefined && !enter)) return;
    event.preventDefault();
    if (step === undefined) pick(options[active]);
    else setActive((i) => (i + step + options.length) % options.length);
  };

  const activeKey = options[active]?.key;
  const loaded = searching && data !== undefined;

  return (
    <Flex vertical gap={token.marginSM}>
      <Input
        autoFocus
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setExpanded(null);
        }}
        maxLength={200}
        onKeyDown={onKeyDown}
        prefix={<SearchOutlined />}
        suffix={query.isFetching && searching ? <Spin size="small" /> : null}
        placeholder={t('shell.search.placeholder')}
        aria-label={t('shell.search.open')}
        role="combobox"
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeKey ? `${listId}-${activeKey}` : undefined}
        data-testid="search-input"
      />
      <SearchFeedback
        q={q}
        searching={searching}
        loaded={loaded}
        count={count}
        error={query.error}
      />
      <ResultList
        id={listId}
        groups={groups}
        activeKey={activeKey}
        onHover={(item) => setActive(options.indexOf(item))}
        onPick={pick}
      />
    </Flex>
  );
}
