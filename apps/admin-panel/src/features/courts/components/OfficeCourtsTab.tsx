import { CreateCourtSchema } from '@nexlegtiq/shared-contracts';
import type { OfficeCourt } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, Bdi, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { Alert, App, Button, Form, Input, Modal, Select, Space, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PagedTable, PAGE_SIZE } from './PagedTable';
import { zodRule } from '../../auth/forms';
import { useCourtMutations, useCourtsList, useOfficeCourts } from '../hooks';

/** Offices' own courts from before the platform list (D-266): replace each with a platform court, or promote it. */
export function OfficeCourtsTab(): React.JSX.Element {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [replacing, setReplacing] = useState<OfficeCourt | null>(null);
  const [promoting, setPromoting] = useState<OfficeCourt | null>(null);
  const list = useOfficeCourts({
    page: String(page),
    limit: String(PAGE_SIZE),
    ...(search ? { search } : {}),
  });

  return (
    <section data-testid="office-courts">
      <Typography.Paragraph type="secondary">
        {t('admin.courts.officeCourts.hint')}
      </Typography.Paragraph>
      <Input.Search
        allowClear
        placeholder={t('admin.courts.searchOffice')}
        aria-label={t('admin.courts.searchOffice')}
        onSearch={(value) => {
          setSearch(value.trim());
          setPage(1);
        }}
        style={{ maxInlineSize: 360, marginBlockEnd: 16 }}
        data-testid="office-courts-search"
      />
      <PagedTable<OfficeCourt>
        query={list}
        page={page}
        onPage={setPage}
        empty={t('admin.courts.officeCourts.empty')}
        testId="office-courts"
        columns={[
          { title: t('admin.courts.columns.nameAr'), render: (_, c) => <Bdi>{c.nameAr}</Bdi> },
          { title: t('admin.courts.columns.city'), render: (_, c) => <Bdi>{c.city}</Bdi> },
          {
            title: t('admin.courts.columns.office'),
            render: (_, c) => (
              <Bdi>
                {c.officeName} · {t(`enums.jurisdiction.${c.jurisdiction}`)}
              </Bdi>
            ),
          },
          {
            title: t('admin.courts.columns.usage'),
            render: (_, c) =>
              t('admin.courts.usage', {
                files: c.fileCount,
                sessions: c.sessionCount,
                judges: c.judgeCount,
              }),
          },
          {
            title: t('admin.courts.columns.actions'),
            render: (_, c) => (
              <Space>
                <Button
                  size="small"
                  onClick={() => setReplacing(c)}
                  data-testid={`office-court-replace-${c.id}`}
                >
                  {t('admin.courts.officeCourts.replace')}
                </Button>
                <Button
                  size="small"
                  onClick={() => setPromoting(c)}
                  data-testid={`office-court-promote-${c.id}`}
                >
                  {t('admin.courts.officeCourts.promote')}
                </Button>
              </Space>
            ),
          },
        ]}
      />
      {replacing ? <ReplaceModal court={replacing} onClose={() => setReplacing(null)} /> : null}
      {promoting ? <PromoteModal court={promoting} onClose={() => setPromoting(null)} /> : null}
    </section>
  );
}

/** Picks an active platform court of the office court's country (server search). */
function ReplaceModal({
  court,
  onClose,
}: {
  readonly court: OfficeCourt;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<string | undefined>();
  const { replace } = useCourtMutations();
  const options = useCourtsList({
    jurisdiction: court.jurisdiction,
    limit: '50',
    ...(search ? { search } : {}),
  });
  const arabic = i18n.language === 'ar';

  const submit = async (): Promise<void> => {
    if (!target) return;
    try {
      const result = await replace.mutateAsync({ id: court.id, courtId: target });
      void message.success(t('admin.courts.officeCourts.replaced', result));
      onClose();
    } catch (error) {
      notify(error);
    }
  };

  return (
    <Modal
      open
      title={t('admin.courts.officeCourts.replaceTitle')}
      okText={t('admin.courts.officeCourts.replace')}
      cancelText={t('common.actions.cancel')}
      okButtonProps={{ disabled: !target, danger: true, 'data-testid': 'replace-confirm' }}
      confirmLoading={replace.isPending}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <Alert type="warning" showIcon message={t('admin.courts.officeCourts.replaceHint')} />
      <Form layout="vertical" style={{ marginBlockStart: 16 }}>
        <Form.Item label={t('admin.courts.officeCourts.target')} htmlFor="replace-target">
          <Select<string>
            id="replace-target"
            showSearch={{ filterOption: false, onSearch: (value) => setSearch(value.trim()) }}
            value={target}
            onChange={setTarget}
            loading={options.isFetching}
            options={(options.data?.items ?? [])
              .filter((option) => option.isActive)
              .map((option) => ({
                value: option.id,
                label: arabic ? option.nameAr : (option.nameEn ?? option.nameAr),
              }))}
            data-testid="replace-target"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** Turns the office court into a platform court; asks for the English name it lacks (the platform key). */
function PromoteModal({
  court,
  onClose,
}: {
  readonly court: OfficeCourt;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<{ nameEn?: string }>();
  const { promote } = useCourtMutations();

  const submit = async (): Promise<void> => {
    try {
      const { nameEn } = await form.validateFields();
      const value = nameEn?.trim();
      await promote.mutateAsync({
        id: court.id,
        body: value && value !== court.nameEn ? { nameEn: value } : {},
      });
      void message.success(t('admin.courts.officeCourts.promoted'));
      onClose();
    } catch (error) {
      // A failed validation was already shown on its field.
      if (error && typeof error === 'object' && 'errorFields' in error) return;
      applyToForm(form, error, ['nameEn']);
    }
  };

  return (
    <Modal
      open
      title={t('admin.courts.officeCourts.promoteTitle')}
      okText={t('admin.courts.officeCourts.promote')}
      cancelText={t('common.actions.cancel')}
      okButtonProps={{ 'data-testid': 'promote-confirm' }}
      confirmLoading={promote.isPending}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <Typography.Paragraph>{t('admin.courts.officeCourts.promoteHint')}</Typography.Paragraph>
      <Form form={form} layout="vertical" noValidate initialValues={{ nameEn: court.nameEn ?? '' }}>
        <Form.Item
          name="nameEn"
          label={t('admin.courts.columns.nameEn')}
          rules={zodRule(CreateCourtSchema.shape.nameEn, translateKey)}
        >
          <Input dir="ltr" data-testid="promote-name-en" />
        </Form.Item>
      </Form>
      {promote.isError ? <ApiErrorAlert error={promote.error} fields={['nameEn']} /> : null}
    </Modal>
  );
}
