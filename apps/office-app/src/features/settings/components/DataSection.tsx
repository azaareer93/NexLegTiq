import { DownloadOutlined, ExportOutlined } from '@ant-design/icons';
import { exportsApi } from '@nexlegtiq/shared-api-client';
import type { OfficeExport } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, useCan, useFormat } from '@nexlegtiq/shared-ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Card, List, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../auth';

const exports = exportsApi(apiClient);
const exportsKey = ['office', 'exports'] as const;
const STATUS_COLOR = {
  QUEUED: 'default',
  RUNNING: 'processing',
  READY: 'success',
  FAILED: 'error',
} as const;
const MB = 1024 * 1024;
/** Whole megabytes, at least 1 (a small export still reads as a size). */
const megabytes = (bytes: string | null) => Math.max(1, Math.round(Number(bytes ?? 0) / MB));

/** Opens a short download link (D-013) in this tab: the file is an attachment, the page stays. */
function save(url: string): void {
  const link = document.createElement('a');
  link.href = url;
  document.body.append(link);
  link.click();
  link.remove();
}

const isExpired = (item: OfficeExport) =>
  item.expiresAt !== null && Date.parse(item.expiresAt) <= Date.now();

function ExportRow({ item }: { readonly item: OfficeExport }) {
  const { t } = useTranslation();
  const format = useFormat();
  const download = useMutation({ mutationFn: () => exports.download(item.id) });
  const expired = isExpired(item);
  const until = item.status === 'READY' && !expired ? item.expiresAt : null;
  return (
    <List.Item
      data-testid={`export-${item.id}`}
      actions={
        until
          ? [
              <Button
                key="download"
                icon={<DownloadOutlined />}
                loading={download.isPending}
                onClick={() =>
                  download.mutate(undefined, { onSuccess: (r) => save(r.downloadUrl) })
                }
                data-testid={`export-download-${item.id}`}
              >
                {t('settings.data.download')}
              </Button>,
            ]
          : []
      }
    >
      <List.Item.Meta
        title={
          <>
            {format.dateTime(item.createdAt)}{' '}
            <Tag color={expired ? 'default' : STATUS_COLOR[item.status]}>
              {expired ? t('settings.data.expired') : t(`settings.data.status.${item.status}`)}
            </Tag>
          </>
        }
        description={
          until
            ? t('settings.data.until', {
                date: format.date(until),
                size: format.number(megabytes(item.sizeBytes)),
              })
            : null
        }
      />
      {download.isError ? <ApiErrorAlert error={download.error} /> : null}
    </List.Item>
  );
}

/** Settings → Data (MVP-106, D-184): export everything the office holds, as the DPA promises. */
export function DataSection() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const mayExport = useCan('export:office');
  const list = useQuery({
    queryKey: exportsKey,
    queryFn: ({ signal }) => exports.listOffice(signal),
    enabled: mayExport,
    // While one is being prepared, look again every 10 s.
    refetchInterval: (query) =>
      query.state.data?.some((e) => e.status === 'QUEUED' || e.status === 'RUNNING')
        ? 10_000
        : false,
  });
  const request = useMutation({
    mutationFn: () => exports.requestOffice(),
    onSuccess: () => {
      void message.success(t('settings.data.requested'));
      void queryClient.invalidateQueries({ queryKey: exportsKey });
    },
  });
  if (!mayExport) return null;
  return (
    <Card title={t('settings.data.title')} data-testid="settings-data">
      <Typography.Paragraph type="secondary">{t('settings.data.hint')}</Typography.Paragraph>
      <Button
        icon={<ExportOutlined />}
        loading={request.isPending}
        onClick={() => request.mutate()}
        data-testid="export-request"
      >
        {t('settings.data.request')}
      </Button>
      {request.isError ? <ApiErrorAlert error={request.error} /> : null}
      {list.data && list.data.length > 0 ? (
        <List
          style={{ marginBlockStart: 16 }}
          dataSource={list.data}
          renderItem={(item) => <ExportRow item={item} />}
          data-testid="export-list"
        />
      ) : null}
    </Card>
  );
}

/** Profile → "Download my data": the user's own data saved as a JSON file. */
export function useMyDataDownload() {
  return useMutation({
    mutationFn: async () => {
      const data = await exports.mine();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'my-nexlegtiq-data.json';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
  });
}
