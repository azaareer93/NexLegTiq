import { CreateLegalResearchSchema } from '@nexlegtiq/shared-contracts';
import type { CreateLegalResearchRequest, LegalResearch } from '@nexlegtiq/shared-contracts';
import { JURISDICTIONS } from '@nexlegtiq/shared-types';
import {
  AiDisclaimer,
  ApiErrorAlert,
  Bdi,
  LoadingSkeleton,
  PageHeader,
  useApiErrorHandler,
} from '@nexlegtiq/shared-ui';
import { Alert, Button, Card, Flex, Form, Input, Select, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAiJob } from '../../ai/use-ai';
import { zodRule } from '../../auth/forms';
import { useAskResearch, useResearchResult } from '../use-research';

/** The answer with its sources (D-256): links open in a new tab, an answer without any source is labelled. */
function ResearchAnswer({ research }: { readonly research: LegalResearch }) {
  const { t } = useTranslation();
  return (
    <Card
      title={t('research.answer.title')}
      extra={
        research.unsourced ? (
          <Tag color="warning" data-testid="research-unsourced">
            {t('research.answer.unsourced')}
          </Tag>
        ) : null
      }
      data-testid="research-answer"
    >
      <Flex vertical gap={16}>
        <AiDisclaimer />
        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBlockEnd: 0 }}>
          {research.answer}
        </Typography.Paragraph>
        {research.jurisdictionNote ? (
          <Alert
            type="info"
            showIcon
            title={t('research.answer.note')}
            description={research.jurisdictionNote}
          />
        ) : null}
        {research.unsourced ? (
          <Alert type="warning" showIcon title={t('research.answer.unsourcedHint')} />
        ) : (
          <section aria-labelledby="research-sources">
            <Typography.Title level={2} id="research-sources">
              {t('research.answer.sources')}
            </Typography.Title>
            <ol style={{ paddingInlineStart: 24, marginBlock: 0 }} data-testid="research-sources">
              {research.citations.map((citation) => (
                <li key={citation.url}>
                  <a href={citation.url} target="_blank" rel="noopener noreferrer">
                    <Bdi>{citation.title}</Bdi>
                  </a>{' '}
                  <Typography.Text type="secondary" dir="ltr">
                    {new URL(citation.url).hostname}
                    {citation.date ? ` · ${citation.date}` : ''}
                  </Typography.Text>
                </li>
              ))}
            </ol>
          </section>
        )}
        <Typography.Text type="secondary">
          {t('research.answer.meta', {
            model: research.model,
            jurisdiction: t(`enums.jurisdiction.${research.jurisdiction}`),
          })}
        </Typography.Text>
      </Flex>
    </Card>
  );
}

/** A queued question: followed by `ai.job.*` and polling, then its answer is read. */
function PendingResearch({ jobId }: { readonly jobId: string }) {
  const { t } = useTranslation();
  const { data: job } = useAiJob(jobId);
  const result = useResearchResult(jobId, job?.status === 'SUCCEEDED');
  if (job?.status === 'FAILED') {
    return (
      <Flex vertical gap={8} data-testid="research-failed">
        <Alert type="error" showIcon title={t('research.failed')} />
        <ApiErrorAlert error={{ code: job.errorCode ?? 'SYS-001' }} />
      </Flex>
    );
  }
  if (result.error) return <ApiErrorAlert error={result.error} />;
  if (result.data) return <ResearchAnswer research={result.data} />;
  return (
    <Card size="small" aria-busy data-testid="research-pending">
      <Flex vertical gap={8}>
        <span role="status">{t('research.pending')}</span>
        <LoadingSkeleton />
      </Flex>
    </Card>
  );
}

/** Legal research (D-256): a general question, answered from official sources first, with its citations. */
export function LegalResearchPage() {
  const { t, i18n } = useTranslation();
  const { translateKey: message } = useApiErrorHandler();
  const ask = useAskResearch();
  const [jobId, setJobId] = useState<string>();
  const [answer, setAnswer] = useState<LegalResearch>();
  const fields = CreateLegalResearchSchema.shape;

  const submit = (values: CreateLegalResearchRequest) => {
    setJobId(undefined);
    setAnswer(undefined);
    ask.mutate(values, {
      onSuccess: (result) => ('jobId' in result ? setJobId(result.jobId) : setAnswer(result)),
    });
  };

  return (
    <Flex vertical gap={16}>
      <PageHeader title={t('research.title')} subtitle={t('research.intro')} />
      <Alert type="warning" showIcon title={t('research.noCaseData')} />
      <Card>
        <Form<CreateLegalResearchRequest>
          layout="vertical"
          initialValues={{ language: i18n.language.startsWith('ar') ? 'AR' : 'EN' }}
          onFinish={submit}
        >
          <Form.Item
            name="question"
            label={t('research.form.question')}
            rules={zodRule(fields.question, message)}
          >
            <Input.TextArea
              rows={4}
              maxLength={2000}
              showCount
              placeholder={t('research.form.questionPlaceholder')}
              data-testid="research-question"
            />
          </Form.Item>
          <Flex gap={16} wrap>
            <Form.Item name="language" label={t('research.form.language')}>
              <Select
                style={{ minInlineSize: 160 }}
                options={(['AR', 'EN'] as const).map((value) => ({
                  value,
                  label: t(`research.language.${value}`),
                }))}
                data-testid="research-language"
              />
            </Form.Item>
            <Form.Item
              name="jurisdiction"
              label={t('research.form.jurisdiction')}
              extra={t('research.form.jurisdictionHint')}
            >
              <Select
                allowClear
                style={{ minInlineSize: 220 }}
                options={JURISDICTIONS.map((value) => ({
                  value,
                  label: t(`enums.jurisdiction.${value}`),
                }))}
                data-testid="research-jurisdiction"
              />
            </Form.Item>
          </Flex>
          <Button
            type="primary"
            htmlType="submit"
            loading={ask.isPending}
            data-testid="research-submit"
          >
            {t('research.form.submit')}
          </Button>
        </Form>
      </Card>
      <ApiErrorAlert error={ask.error} />
      {answer ? <ResearchAnswer research={answer} /> : null}
      {jobId ? <PendingResearch jobId={jobId} /> : null}
    </Flex>
  );
}
