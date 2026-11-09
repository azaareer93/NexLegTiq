import { CopyOutlined, FlagOutlined, ReloadOutlined, TranslationOutlined } from '@ant-design/icons';
import type { AiSummaryListItem } from '@nexlegtiq/shared-contracts';
import { AI_FEEDBACK_REASONS } from '@nexlegtiq/shared-types';
import type { AiFeedbackReason } from '@nexlegtiq/shared-types';
import { AiDisclaimer, Bdi, useApiErrorHandler, useFormat } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { App, Button, Card, Flex, Form, Input, List, Modal, Select, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSummaryFeedback } from './use-ai';

type Language = AiSummaryListItem['language'];

export interface SummaryCardProps {
  readonly item: AiSummaryListItem;
  /** Regenerate (`force`) or generate the other language; the tab follows the job. */
  readonly onRequest: (language: Language, force: boolean) => void;
  readonly busy: boolean;
  /** Null when the user may not write notes (or the file is archived). */
  readonly onCopyToNote: (() => void) | null;
}

const PLAIN = { unicodeBidi: 'plaintext', textAlign: 'start' } as const;

function Section({ title, items }: { readonly title: string; readonly items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <Typography.Text strong>{title}</Typography.Text>
      <List
        size="small"
        split={false}
        dataSource={[...items]}
        renderItem={(entry) => <List.Item style={PLAIN}>{entry}</List.Item>}
      />
    </div>
  );
}

function FeedbackModal({
  summaryId,
  onClose,
}: {
  readonly summaryId: string;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const feedback = useSummaryFeedback();
  const [form] = Form.useForm<{ reason: AiFeedbackReason; comment?: string }>();
  return (
    <Modal
      open
      title={t('aiSummary.feedback.title')}
      onCancel={onClose}
      okText={t('common.actions.save')}
      cancelText={t('common.actions.cancel')}
      confirmLoading={feedback.isPending}
      onOk={() => form.submit()}
      okButtonProps={{ 'data-testid': 'ai-feedback-submit' }}
    >
      <Form
        form={form}
        layout="vertical"
        noValidate
        onFinish={(values) =>
          feedback.mutate(
            {
              id: summaryId,
              body: { reason: values.reason, comment: values.comment?.trim() || undefined },
            },
            {
              onSuccess: () => {
                void message.success(t('aiSummary.feedback.sent'));
                onClose();
              },
              onError: notify,
            },
          )
        }
      >
        <Form.Item
          name="reason"
          label={t('aiSummary.feedback.reason')}
          rules={[{ required: true }]}
        >
          <Select
            data-testid="ai-feedback-reason"
            options={AI_FEEDBACK_REASONS.map((reason) => ({
              value: reason,
              label: t(`enums.aiFeedbackReason.${reason}`),
            }))}
          />
        </Form.Item>
        <Form.Item name="comment" label={t('aiSummary.feedback.comment')}>
          <Input.TextArea rows={3} maxLength={1000} data-testid="ai-feedback-comment" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** One AI summary (D-148); the disclaimer is part of the card, never optional (D-057). */
export function SummaryCard({ item, onRequest, busy, onCopyToNote }: SummaryCardProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const [reporting, setReporting] = useState(false);
  const other: Language = item.language === 'AR' ? 'EN' : 'AR';
  return (
    <Card size="small" data-testid={`ai-summary-${item.id}`}>
      <Flex vertical gap={12}>
        <Flex gap={8} wrap align="center">
          <Typography.Text strong>
            <Bdi>{item.source.name}</Bdi>
          </Typography.Text>
          <Tag>{t(`aiSummary.language.${item.language}`)}</Tag>
          <Typography.Text type="secondary">
            {t('aiSummary.model', { model: isolate(item.model) })} ·{' '}
            {t('aiSummary.generatedAt', { date: format.dateTime(item.createdAt) })}
          </Typography.Text>
        </Flex>
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBlockEnd: 0, ...PLAIN }}>
          {item.summary}
        </Typography.Paragraph>
        <Section title={t('aiSummary.summary.keyFacts')} items={item.keyFacts} />
        <Section title={t('aiSummary.summary.legalIssues')} items={item.keyLegalIssues} />
        <Section title={t('aiSummary.summary.parties')} items={item.parties} />
        <Section
          title={t('aiSummary.summary.dates')}
          items={item.dates.map((entry) => `${entry.date}: ${entry.event}`)}
        />
        <AiDisclaimer />
        <Flex gap={8} wrap>
          <Button
            size="small"
            icon={<ReloadOutlined aria-hidden />}
            disabled={busy}
            onClick={() => onRequest(item.language, true)}
            data-testid={`ai-regenerate-${item.id}`}
          >
            {t('aiSummary.actions.regenerate')}
          </Button>
          <Button
            size="small"
            icon={<TranslationOutlined aria-hidden />}
            disabled={busy}
            onClick={() => onRequest(other, false)}
            data-testid={`ai-switch-${item.id}`}
          >
            {t('aiSummary.actions.switchTo', { language: t(`aiSummary.language.${other}`) })}
          </Button>
          {onCopyToNote ? (
            <Button
              size="small"
              icon={<CopyOutlined aria-hidden />}
              onClick={onCopyToNote}
              data-testid={`ai-copy-${item.id}`}
            >
              {t('aiSummary.actions.copyToNote')}
            </Button>
          ) : null}
          <Button
            size="small"
            icon={<FlagOutlined aria-hidden />}
            onClick={() => setReporting(true)}
            data-testid={`ai-report-${item.id}`}
          >
            {t('aiSummary.actions.reportIssue')}
          </Button>
        </Flex>
      </Flex>
      {reporting ? <FeedbackModal summaryId={item.id} onClose={() => setReporting(false)} /> : null}
    </Card>
  );
}
