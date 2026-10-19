import type { OfficeSubscription, PlanFeature } from '@nexlegtiq/shared-contracts';
import { PLAN_FEATURES } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  Bdi,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  StatusTag,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Alert, Card, Descriptions, Flex, Progress, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { useSubscription } from '../api/use-subscription';

const MB_PER_GB = 1024;

function UsageRow({
  label,
  used,
  limit,
  show,
  testId,
}: {
  readonly label: string;
  readonly used: number;
  readonly limit: number | null;
  readonly show: (value: number) => string;
  readonly testId: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const text =
    limit === null
      ? t('settings.subscription.usage.unlimited', { used: isolate(show(used)) })
      : t('settings.subscription.usage.of', {
          used: isolate(show(used)),
          limit: isolate(show(limit)),
        });
  return (
    <Flex vertical gap={2} data-testid={testId}>
      <Flex justify="space-between" gap={8} wrap>
        <Typography.Text>{label}</Typography.Text>
        <Typography.Text type="secondary">{text}</Typography.Text>
      </Flex>
      {limit === null ? null : (
        <Progress
          percent={limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100))}
          status={used >= limit ? 'exception' : 'normal'}
          showInfo={false}
          aria-label={`${label}: ${text}`}
        />
      )}
    </Flex>
  );
}

function Usage({
  usage,
  limits,
  size,
}: {
  readonly usage: NonNullable<OfficeSubscription['usage']>;
  readonly limits: NonNullable<OfficeSubscription['limits']>;
  readonly size: (mb: number) => string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <>
      <Typography.Text strong>{t('settings.subscription.usage.title')}</Typography.Text>
      <UsageRow
        label={t('settings.subscription.usage.users')}
        used={usage.users}
        limit={limits.users}
        show={(n) => format.number(n)}
        testId="usage-users"
      />
      <UsageRow
        label={t('settings.subscription.usage.storage')}
        used={usage.storageMb}
        limit={limits.storageMb}
        show={size}
        testId="usage-storage"
      />
      <UsageRow
        label={t('settings.subscription.usage.ai')}
        used={usage.aiThisMonth}
        limit={limits.aiMonthly}
        show={(n) => format.number(n)}
        testId="usage-ai"
      />
    </>
  );
}

function SubscriptionDetails({ data }: { readonly data: OfficeSubscription }): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const size = (mb: number) =>
    mb >= MB_PER_GB
      ? t('settings.subscription.units.gb', { value: format.number(mb / MB_PER_GB, 1) })
      : t('settings.subscription.units.mb', { value: format.number(mb) });
  const end = (value: string | null) =>
    value ? format.date(value, 'long') : t('settings.subscription.noEnd');
  const featureLabel = (feature: PlanFeature) => t(`settings.subscription.features.${feature}`);

  return (
    <Flex vertical gap={16}>
      {data.readOnly ? (
        <Alert type="error" showIcon title={t('settings.subscription.readOnly')} />
      ) : null}
      <Descriptions column={1} size="small">
        <Descriptions.Item label={t('settings.subscription.plan')}>
          {data.plan ? <Bdi>{data.plan.name}</Bdi> : t('settings.subscription.noPlan')}
        </Descriptions.Item>
        <Descriptions.Item label={t('settings.subscription.status')}>
          <StatusTag
            tone={data.readOnly ? 'error' : data.status === 'PAST_DUE' ? 'warning' : 'success'}
          >
            {t(`enums.subscriptionStatus.${data.status}`)}
          </StatusTag>
        </Descriptions.Item>
        {data.status === 'TRIALING' ? (
          <Descriptions.Item label={t('settings.subscription.trialEnds')}>
            {end(data.trialEndsAt ?? data.periodEnd)}
          </Descriptions.Item>
        ) : (
          <Descriptions.Item label={t('settings.subscription.periodEnds')}>
            {end(data.periodEnd)}
          </Descriptions.Item>
        )}
      </Descriptions>
      {data.usage && data.limits ? (
        <Usage usage={data.usage} limits={data.limits} size={size} />
      ) : null}
      <Typography.Text strong>{t('settings.subscription.features.title')}</Typography.Text>
      <Flex gap={8} wrap>
        {PLAN_FEATURES.map((feature) => (
          <Tag
            key={feature}
            color={data.features[feature] ? 'green' : 'default'}
            data-testid={`feature-${feature}`}
          >
            {t('settings.subscription.features.state', {
              feature: featureLabel(feature),
              state: data.features[feature]
                ? t('settings.subscription.features.included')
                : t('settings.subscription.features.notIncluded'),
            })}
          </Tag>
        ))}
      </Flex>
      <Typography.Text type="secondary">{t('settings.subscription.upgrade')}</Typography.Text>
    </Flex>
  );
}

/** Settings → Subscription (D-122): plan, status, usage bars against the plan's limits, features, how to upgrade. */
export function SubscriptionSection(): React.JSX.Element {
  const { t } = useTranslation();
  const { referenceOf } = useApiErrorHandler();
  const subscription = useSubscription();
  const code = isApiError(subscription.error) ? subscription.error.code : undefined;
  return (
    <Card title={t('settings.subscription.title')} data-testid="subscription-section">
      {subscription.isPending ? (
        <LoadingSkeleton />
      ) : subscription.isError ? (
        <ErrorState
          code={code !== undefined && isErrorCode(code) ? code : undefined}
          requestId={referenceOf(subscription.error)}
          onRetry={() => void subscription.refetch()}
        />
      ) : (
        <SubscriptionDetails data={subscription.data} />
      )}
    </Card>
  );
}
