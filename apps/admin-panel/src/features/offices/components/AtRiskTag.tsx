import { StatusTag } from '@nexlegtiq/shared-ui';
import { Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';

/** D-164: an active office older than 14 days with no change in 14 days; the words say why, not only the colour. */
export function AtRiskTag({ id }: { readonly id: string }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Tooltip title={t('admin.offices.atRiskHint')}>
      {/* Focusable so keyboard users reach the reason too. */}
      <span tabIndex={0} data-testid={`office-at-risk-${id}`}>
        <StatusTag tone="warning">{t('admin.offices.atRisk')}</StatusTag>
      </span>
    </Tooltip>
  );
}
