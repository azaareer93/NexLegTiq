import type { AdminPlan } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  Bdi,
  EmptyState,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  Ltr,
  PageHeader,
  StatusTag,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { App, Button, Popconfirm, Space, Table, Tooltip } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PlanModal } from '../components/PlanModal';
import { usePlanMutations, usePlansList } from '../hooks';

/** `/plans`: the plans offices subscribe to, with create / edit / delete. */
export function PlansPage(): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  const { message } = App.useApp();
  const { notify, referenceOf } = useApiErrorHandler();
  const query = usePlansList();
  const { remove } = usePlanMutations();
  const [editing, setEditing] = useState<AdminPlan | 'new' | null>(null);

  const limit = (value: number | null, unit?: string) => {
    if (value === null) return t('admin.plans.unlimited');
    return unit ? t(unit, { value: format.number(value) }) : format.number(value);
  };

  const onDelete = async (plan: AdminPlan): Promise<void> => {
    try {
      await remove.mutateAsync(plan.id);
      void message.success(t('admin.plans.deleted'));
    } catch (error) {
      notify(error);
    }
  };

  if (query.isError) {
    const code = isApiError(query.error) ? query.error.code : undefined;
    return (
      <div data-testid="plans-error">
        <ErrorState
          code={code !== undefined && isErrorCode(code) ? code : undefined}
          requestId={referenceOf(query.error)}
          onRetry={() => void query.refetch()}
        />
      </div>
    );
  }
  if (!query.data) return <LoadingSkeleton rows={6} />;

  return (
    <section data-testid="page-plans">
      <PageHeader
        title={t('admin.plans.title')}
        extra={
          <Button type="primary" onClick={() => setEditing('new')} data-testid="plan-new">
            {t('admin.plans.new')}
          </Button>
        }
      />
      {query.data.length === 0 ? (
        <EmptyState title={t('admin.plans.empty')} />
      ) : (
        <Table<AdminPlan>
          data-testid="plans-table"
          rowKey="id"
          dataSource={query.data}
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: t('admin.plans.columns.code'),
              render: (_, p) => <Ltr>{p.code}</Ltr>,
            },
            { title: t('admin.plans.columns.name'), render: (_, p) => <Bdi>{p.name}</Bdi> },
            {
              title: t('admin.plans.columns.market'),
              render: (_, p) => t(`enums.planMarket.${p.market}`),
            },
            {
              title: t('admin.plans.columns.price'),
              render: (_, p) => <Bdi>{format.money(p.priceMonthly, p.currency)}</Bdi>,
            },
            {
              title: t('admin.plans.columns.users'),
              render: (_, p) => <Bdi>{limit(p.maxUsers)}</Bdi>,
            },
            {
              title: t('admin.plans.columns.ai'),
              render: (_, p) => <Bdi>{limit(p.aiQuotaMonthly)}</Bdi>,
            },
            {
              title: t('admin.plans.columns.storage'),
              render: (_, p) => <Bdi>{limit(p.storageQuotaMb, 'admin.offices.mb')}</Bdi>,
            },
            {
              title: t('admin.plans.columns.status'),
              render: (_, p) => (
                <StatusTag tone={p.isActive ? 'success' : 'neutral'}>
                  {t(p.isActive ? 'admin.plans.active' : 'admin.plans.inactive')}
                </StatusTag>
              ),
            },
            {
              title: t('admin.plans.columns.subscriptions'),
              render: (_, p) => <Bdi>{format.number(p.subscriptionCount)}</Bdi>,
            },
            {
              title: t('admin.plans.columns.actions'),
              render: (_, p) => (
                <Space>
                  <Button
                    size="small"
                    onClick={() => setEditing(p)}
                    data-testid={`plan-edit-${p.id}`}
                  >
                    {t('common.actions.edit')}
                  </Button>
                  <Tooltip title={p.subscriptionCount > 0 ? t('admin.plans.inUse') : undefined}>
                    <Popconfirm
                      title={t('admin.plans.confirmDelete')}
                      okText={t('common.actions.delete')}
                      cancelText={t('common.actions.cancel')}
                      onConfirm={() => onDelete(p)}
                      disabled={p.subscriptionCount > 0}
                    >
                      <Button
                        size="small"
                        danger
                        disabled={p.subscriptionCount > 0}
                        data-testid={`plan-delete-${p.id}`}
                      >
                        {t('common.actions.delete')}
                      </Button>
                    </Popconfirm>
                  </Tooltip>
                </Space>
              ),
            },
          ]}
        />
      )}
      {editing ? (
        <PlanModal
          plan={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}
