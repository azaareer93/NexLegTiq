import type { ClientQuery } from '@nexlegtiq/shared-contracts';
import { CLIENT_TYPES } from '@nexlegtiq/shared-types';
import { Flex, Grid, Input, Segmented, Select } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useDebounced } from '../list-params';
import type { ListChanges } from '../list-params';

export interface ClientsFiltersProps {
  readonly state: ClientQuery;
  readonly onChange: (changes: ListChanges) => void;
}

type Status = 'all' | 'true' | 'false';

/** Search (as you type, debounced) and filters; every control writes the URL. */
export function ClientsFilters({ state, onChange }: ClientsFiltersProps): React.JSX.Element {
  const { t } = useTranslation();
  const narrow = Grid.useBreakpoint().md === false;
  const [text, setText] = useState(state.search ?? '');
  const search = useDebounced(text.trim());

  useEffect(() => {
    if (search !== (state.search ?? '')) onChange({ search });
    // Only a settled change of the text writes the URL; the URL changing on its own does not echo back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // The search left the URL (filters cleared): empty the box. Typing never removes it, so this cannot fight the user.
  useEffect(() => {
    if (state.search === undefined) setText('');
  }, [state.search]);

  const status: Status = state.isActive === undefined ? 'all' : state.isActive ? 'true' : 'false';
  return (
    <Flex gap={8} wrap align="center">
      <Input.Search
        value={text}
        onChange={(event) => setText(event.target.value)}
        onSearch={(value) => setText(value)}
        placeholder={t('clients.list.searchPlaceholder')}
        aria-label={t('clients.list.searchLabel')}
        allowClear
        // The contract's limit: a longer term would be dropped from the URL, not searched.
        maxLength={100}
        style={{ inlineSize: narrow ? '100%' : 320 }}
        data-testid="clients-search"
      />
      <Select
        allowClear
        placeholder={t('clients.list.filters.clientType')}
        aria-label={t('clients.list.filters.clientType')}
        value={state.clientType}
        onChange={(value?: string) => onChange({ clientType: value })}
        options={CLIENT_TYPES.map((value) => ({ value, label: t(`enums.clientType.${value}`) }))}
        style={{ minInlineSize: 160 }}
        data-testid="clients-filter-type"
      />
      <Segmented<Status>
        aria-label={t('clients.list.filters.status')}
        value={status}
        onChange={(value) => onChange({ isActive: value === 'all' ? undefined : value })}
        options={[
          { value: 'all', label: t('clients.list.filters.all') },
          { value: 'true', label: t('clients.list.filters.active') },
          { value: 'false', label: t('clients.list.filters.inactive') },
        ]}
        data-testid="clients-filter-status"
      />
    </Flex>
  );
}
