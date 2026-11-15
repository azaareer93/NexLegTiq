import { Bdi } from '@nexlegtiq/shared-ui';
import { Select } from 'antd';
import { useTranslation } from 'react-i18next';

import { useCasesList } from '../../cases/api/use-cases';

/** Picks one of the user's recent cases (the one just created comes first). */
export function CasePicker({
  value,
  onChange,
  testId,
}: {
  readonly value: string | undefined;
  readonly onChange: (id: string) => void;
  readonly testId: string;
}) {
  const { t } = useTranslation();
  // Newest changes first (the default sort): a case just created is at the top.
  const cases = useCasesList({ limit: '20' });
  return (
    <Select
      value={value}
      onChange={onChange}
      loading={cases.isPending}
      placeholder={t('onboarding.pickCase')}
      aria-label={t('onboarding.pickCase')}
      notFoundContent={t('onboarding.noCases')}
      style={{ minInlineSize: 280, maxInlineSize: '100%' }}
      data-testid={testId}
      options={(cases.data?.items ?? []).map((c) => ({
        value: c.id,
        label: (
          <Bdi>
            {c.fileNumber} · {c.title}
          </Bdi>
        ),
      }))}
    />
  );
}
