import type { CaseQuery } from '@nexlegtiq/shared-contracts';
import { FILE_STATUSES, FILE_TYPES, PRIORITIES } from '@nexlegtiq/shared-types';
import { Button, Flex, Grid, Input, Select, Tag } from 'antd';
import { useTranslation } from 'react-i18next';

import { VIEW_KEYS } from '../list-params';
import type { ListChanges, ViewKey } from '../list-params';

export interface CasesFiltersProps {
  readonly state: CaseQuery;
  /** The view the filters equal, if any (shown pressed). */
  readonly view: ViewKey | undefined;
  readonly onChange: (changes: ListChanges) => void;
  readonly onView: (view: ViewKey) => void;
}

/** The quick views, search and filters of the list; every control writes the URL. */
export function CasesFilters({
  state,
  view,
  onChange,
  onView,
}: CasesFiltersProps): React.JSX.Element {
  const { t } = useTranslation();
  const narrow = Grid.useBreakpoint().md === false;
  return (
    <>
      <Flex gap={8} wrap role="group" aria-label={t('cases.list.views.label')}>
        {VIEW_KEYS.map((key) => (
          <Button
            key={key}
            size="small"
            shape="round"
            type={view === key ? 'primary' : 'default'}
            aria-pressed={view === key}
            onClick={() => onView(key)}
            data-testid={`cases-view-${key}`}
          >
            {t(`cases.list.views.${key}`)}
          </Button>
        ))}
      </Flex>
      <Flex gap={8} wrap align="center">
        <Input.Search
          key={state.search ?? ''}
          defaultValue={state.search}
          placeholder={t('cases.list.searchPlaceholder')}
          aria-label={t('cases.list.searchLabel')}
          allowClear
          // The contract's limit: a longer term would be dropped from the URL, not searched.
          maxLength={100}
          onSearch={(value) => onChange({ search: value.trim() })}
          style={{ inlineSize: narrow ? '100%' : 320 }}
          data-testid="cases-search"
        />
        <Select
          allowClear
          placeholder={t('cases.list.filters.status')}
          aria-label={t('cases.list.filters.status')}
          value={state.status}
          onChange={(value?: string) => onChange({ status: value })}
          options={FILE_STATUSES.map((value) => ({ value, label: t(`enums.fileStatus.${value}`) }))}
          style={{ minInlineSize: 140 }}
          data-testid="cases-filter-status"
        />
        <Select
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          placeholder={t('cases.list.filters.fileType')}
          aria-label={t('cases.list.filters.fileType')}
          value={state.fileType ?? []}
          onChange={(value: string[]) => onChange({ fileType: value.join(',') })}
          options={FILE_TYPES.map((value) => ({ value, label: t(`enums.fileType.${value}`) }))}
          style={{ minInlineSize: 200 }}
          data-testid="cases-filter-type"
        />
        <Select
          allowClear
          placeholder={t('cases.list.filters.priority')}
          aria-label={t('cases.list.filters.priority')}
          value={state.priority}
          onChange={(value?: string) => onChange({ priority: value })}
          options={PRIORITIES.map((value) => ({ value, label: t(`enums.priority.${value}`) }))}
          style={{ minInlineSize: 140 }}
          data-testid="cases-filter-priority"
        />
        {state.clientId ? (
          <Tag closable onClose={() => onChange({ clientId: undefined })}>
            {t('cases.list.filters.client')}
          </Tag>
        ) : null}
        {state.responsibleLawyerId ? (
          <Tag closable onClose={() => onChange({ responsibleLawyerId: undefined })}>
            {t('cases.list.filters.lawyer')}
          </Tag>
        ) : null}
      </Flex>
    </>
  );
}
