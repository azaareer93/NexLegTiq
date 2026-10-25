import { LockOutlined } from '@ant-design/icons';
import type { Case } from '@nexlegtiq/shared-contracts';
import { Bdi, Ltr, useFormat, useLanguage } from '@nexlegtiq/shared-ui';
import { Card, Col, Descriptions, Flex, Row, Statistic, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { FileActions } from '../file-page';
import { ClientsCard } from './FileClientsCard';
import { TeamCard } from './FileTeamCard';
import { NextHearingCard } from '../sessions/NextHearingCard';

/** A value, or "not set" for an empty one. */
function Value({ children }: { readonly children: ReactNode }): ReactNode {
  const { t } = useTranslation();
  return children === null || children === undefined || children === '' ? (
    <Typography.Text type="secondary">{t('cases.file.notSet')}</Typography.Text>
  ) : (
    children
  );
}

function OverviewCard({ file }: { readonly file: Case }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Card title={t('cases.file.cards.overview')} data-testid="case-card-overview">
      <Descriptions column={1} size="small">
        <Descriptions.Item label={t('cases.file.fields.fileType')}>
          {t(`enums.fileType.${file.fileType}`)}
        </Descriptions.Item>
        <Descriptions.Item label={t('cases.file.fields.subType')}>
          <Value>{file.subType ? <Bdi>{file.subType}</Bdi> : null}</Value>
        </Descriptions.Item>
        <Descriptions.Item label={t('cases.file.fields.openingDate')}>
          {format.date(file.openingDate)}
        </Descriptions.Item>
        <Descriptions.Item label={t('cases.file.fields.closingDate')}>
          <Value>{file.closingDate ? format.date(file.closingDate) : null}</Value>
        </Descriptions.Item>
        <Descriptions.Item label={t('cases.file.fields.jurisdiction')}>
          {t(`enums.jurisdiction.${file.jurisdiction}`)}
        </Descriptions.Item>
        <Descriptions.Item label={t('cases.file.fields.confidential')}>
          {file.isConfidential ? (
            <Tag icon={<LockOutlined aria-hidden />}>{t('cases.list.confidential')}</Tag>
          ) : (
            t('cases.file.no')
          )}
        </Descriptions.Item>
        <Descriptions.Item label={t('cases.file.fields.description')}>
          <Value>
            {file.description ? (
              <Typography.Paragraph
                dir="auto"
                style={{ whiteSpace: 'pre-wrap', marginBlockEnd: 0 }}
              >
                {file.description}
              </Typography.Paragraph>
            ) : null}
          </Value>
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function CourtCard({ file }: { readonly file: Case }): React.JSX.Element {
  const { t } = useTranslation();
  const { locale } = useLanguage();
  const court = file.court;
  // Platform courts always have an English name; an office's own may not (D-115).
  const courtName = court
    ? locale === 'en'
      ? (court.nameEn ?? court.nameAr)
      : court.nameAr
    : null;
  return (
    <Card title={t('cases.file.cards.court')} data-testid="case-card-court">
      <Descriptions column={1} size="small">
        <Descriptions.Item label={t('legal.court')}>
          <Value>{courtName ? <Bdi>{courtName}</Bdi> : null}</Value>
        </Descriptions.Item>
        <Descriptions.Item label={t('cases.file.fields.courtType')}>
          <Value>{court ? t(`enums.courtType.${court.courtType}`) : null}</Value>
        </Descriptions.Item>
        <Descriptions.Item label={t('legal.judge')}>
          <Value>{file.judge ? <Bdi>{file.judge.fullName}</Bdi> : null}</Value>
        </Descriptions.Item>
        <Descriptions.Item label={t('legal.courtCaseNumber')}>
          <Value>{file.courtCaseNumber ? <Ltr>{file.courtCaseNumber}</Ltr> : null}</Value>
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

/** Shown only when the API returned the billing terms (holders of an invoice permission, D-096). */
function BillingCard({ file }: { readonly file: Case }): React.JSX.Element | null {
  const { t } = useTranslation();
  const format = useFormat();
  if (file.billingMethod === null) return null;
  const money = (amount: string | null) =>
    amount === null ? null : format.money(amount, file.currency);
  return (
    <Card title={t('cases.file.cards.billing')} data-testid="case-card-billing">
      <Descriptions column={1} size="small">
        <Descriptions.Item label={t('cases.file.billing.method')}>
          {t(`enums.billingMethod.${file.billingMethod}`)}
        </Descriptions.Item>
        <Descriptions.Item label={t('cases.file.billing.rate')}>
          <Value>{money(file.hourlyRate)}</Value>
        </Descriptions.Item>
        <Descriptions.Item label={t('cases.file.billing.fee')}>
          <Value>{money(file.fixedFee)}</Value>
        </Descriptions.Item>
        <Descriptions.Item label={t('legal.retainer')}>
          <Value>{money(file.retainerBalance)}</Value>
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );
}

function CountsCard({ file }: { readonly file: Case }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const counts = [
    ['clients', file.clients.length],
    ['team', file.team.length],
    ['parties', file.counts.parties],
    ['notes', file.counts.notes],
  ] as const;
  return (
    <Card title={t('cases.file.cards.counts')} data-testid="case-card-counts">
      <Row gutter={[16, 16]}>
        {counts.map(([key, value]) => (
          <Col span={12} key={key}>
            <Statistic
              title={t(`cases.file.counts.${key}`)}
              value={value}
              formatter={() => format.number(value)}
            />
          </Col>
        ))}
      </Row>
    </Card>
  );
}

/** The Details tab (frontend.md#legal-file-page): the file's fields and cards, two columns on wide screens. */
export function CaseDetailsTab({
  file,
  actions,
  onOpenHearing,
}: {
  readonly file: Case;
  /** What the user may change (D-051, D-096, D-118); clients and team follow `edit`. */
  readonly actions: Pick<FileActions, 'edit' | 'reassign' | 'confidentiality'>;
  /** Opens a hearing in the drawer (from the next-hearing card). */
  readonly onOpenHearing: (id: string) => void;
}): React.JSX.Element {
  return (
    <Row gutter={[16, 16]} data-testid="case-details">
      <Col xs={24} lg={14}>
        <Flex vertical gap={16}>
          <OverviewCard file={file} />
          <CourtCard file={file} />
          <BillingCard file={file} />
        </Flex>
      </Col>
      <Col xs={24} lg={10}>
        <Flex vertical gap={16}>
          <NextHearingCard fileId={file.id} onOpen={onOpenHearing} />
          <CountsCard file={file} />
          <ClientsCard file={file} canEdit={actions.edit} />
          <TeamCard file={file} actions={actions} />
        </Flex>
      </Col>
    </Row>
  );
}
