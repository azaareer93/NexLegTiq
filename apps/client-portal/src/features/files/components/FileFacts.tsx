import type { PortalFile } from '@nexlegtiq/shared-contracts';
import type { FileStatus } from '@nexlegtiq/shared-types';
import { Bdi, StatusTag, useFormat, useLanguage } from '@nexlegtiq/shared-ui';
import type { StatusTone } from '@nexlegtiq/shared-ui';
import { Typography } from 'antd';
import { useTranslation } from 'react-i18next';

const TONE: Record<FileStatus, StatusTone> = {
  OPEN: 'success',
  SUSPENDED: 'warning',
  CLOSED: 'neutral',
  ARCHIVED: 'neutral',
};

export function FileStatusTag({ status }: { readonly status: FileStatus }): React.JSX.Element {
  const { t } = useTranslation();
  return <StatusTag tone={TONE[status]}>{t(`enums.fileStatus.${status}`)}</StatusTag>;
}

/** "Next hearing: <date>, <court>" in the reading language, or that none is scheduled. */
export function NextHearing({
  hearing,
}: {
  readonly hearing: PortalFile['nextHearing'];
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const { locale } = useLanguage();
  if (!hearing) {
    return <Typography.Text type="secondary">{t('portal.files.noHearing')}</Typography.Text>;
  }
  const court =
    locale === 'ar'
      ? (hearing.courtNameAr ?? hearing.courtNameEn)
      : (hearing.courtNameEn ?? hearing.courtNameAr);
  return (
    <Typography.Text data-testid="next-hearing">
      {t('portal.files.nextHearing')}: <Bdi>{format.dateTime(hearing.startsAt)}</Bdi>
      {court ? (
        <>
          {t('timeline.separator')}
          <bdi>{court}</bdi>
        </>
      ) : null}
    </Typography.Text>
  );
}
