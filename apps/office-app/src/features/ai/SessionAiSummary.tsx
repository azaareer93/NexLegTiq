import { RobotOutlined } from '@ant-design/icons';
import type { AiSummary, Session } from '@nexlegtiq/shared-contracts';
import { AiDisclaimer, ApiErrorAlert, useCan } from '@nexlegtiq/shared-ui';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Checkbox, Flex, List, Tag, Typography } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  aiKeys,
  useAiJob,
  useCreateTasksFromSummary,
  useRequestSessionSummary,
  useSessionSummaries,
} from './use-ai';

/** Minutes longer than this are offered a summary (MVP-87): offered, never run on their own. */
const OFFER_WORDS = 100;
const RISK_COLOR = { LOW: 'success', MEDIUM: 'warning', HIGH: 'error' } as const;

const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

function PendingJob({ jobId, onDone }: { readonly jobId: string; readonly onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useAiJob(jobId);
  const status = data?.status;
  useEffect(() => {
    if (status !== 'SUCCEEDED') return;
    // The button comes back only once the new summary is loaded.
    void queryClient.invalidateQueries({ queryKey: aiKeys.summariesAll }).then(onDone);
  }, [status, queryClient, onDone]);
  if (status === 'FAILED') {
    return (
      <Flex vertical gap={8}>
        <ApiErrorAlert error={{ code: data?.errorCode ?? 'SYS-001' }} />
        <Button onClick={onDone} style={{ alignSelf: 'flex-start' }} data-testid="session-ai-retry">
          {t('aiSummary.failed.dismiss')}
        </Button>
      </Flex>
    );
  }
  return (
    <span role="status" data-testid="session-ai-pending">
      {t('sessions.ai.pending')}
    </span>
  );
}

/** The summary with its next steps as a checklist; the picked ones become tasks only on the user's click (D-179). */
function SummaryView({ summary }: { readonly summary: AiSummary }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const mayCreate = useCan('create:task');
  const create = useCreateTasksFromSummary();
  const [picked, setPicked] = useState<number[]>([]);
  const [done, setDone] = useState<number[]>([]);
  const submit = async () => {
    await create.mutateAsync({
      id: summary.id,
      body: { selected: picked.map((index) => ({ index })) },
    });
    void message.success(t('sessions.ai.tasksCreated', { count: picked.length }));
    setDone((d) => [...d, ...picked]);
    setPicked([]);
  };
  return (
    <Flex vertical gap={8} data-testid="session-ai-summary-view">
      {summary.riskAssessment ? (
        <span>
          {t('sessions.ai.risk')}{' '}
          <Tag color={RISK_COLOR[summary.riskAssessment]} data-testid="session-ai-risk">
            {t(`enums.aiRiskLevel.${summary.riskAssessment}`)}
          </Tag>
        </span>
      ) : null}
      <Typography.Paragraph dir="auto">{summary.summary}</Typography.Paragraph>
      {summary.keyFacts.length ? (
        <List
          size="small"
          header={t('aiSummary.summary.keyFacts')}
          dataSource={summary.keyFacts}
          renderItem={(fact) => <List.Item dir="auto">{fact}</List.Item>}
        />
      ) : null}
      <Typography.Text strong>{t('sessions.ai.nextSteps')}</Typography.Text>
      {summary.nextSteps.length === 0 ? (
        <Typography.Text type="secondary">{t('sessions.ai.noSteps')}</Typography.Text>
      ) : (
        <Checkbox.Group
          value={picked}
          onChange={(values) => setPicked(values as number[])}
          disabled={!mayCreate}
          style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          {summary.nextSteps.map((step, index) => (
            <Checkbox
              key={index}
              value={index}
              disabled={done.includes(index)}
              data-testid={`session-ai-step-${index}`}
            >
              <span dir="auto">{step.action}</span>
              {step.dueInDays === null ? null : (
                <Typography.Text type="secondary">
                  {' · '}
                  {t('sessions.ai.dueIn', { count: step.dueInDays })}
                </Typography.Text>
              )}
              {done.includes(index) ? (
                <Tag style={{ marginInlineStart: 8 }}>{t('sessions.ai.created')}</Tag>
              ) : null}
            </Checkbox>
          ))}
        </Checkbox.Group>
      )}
      {mayCreate && summary.nextSteps.length ? (
        <Button
          type="primary"
          disabled={picked.length === 0}
          loading={create.isPending}
          onClick={() => void submit().catch(() => undefined)}
          data-testid="session-ai-create-tasks"
          style={{ alignSelf: 'flex-start' }}
        >
          {t('sessions.ai.createTasks')}
        </Button>
      ) : null}
      {create.isError ? <ApiErrorAlert error={create.error} /> : null}
      <AiDisclaimer />
    </Flex>
  );
}

/**
 * The AI part of a hearing's drawer (MVP-87, D-179): for users with `use:ai` and a hearing with minutes — long minutes
 * get an offer, a click asks for the summary (in the interface language), and its next steps can become tasks.
 */
export function SessionAiSummary({ session }: { readonly session: Session }) {
  const { t, i18n } = useTranslation();
  const mayUseAi = useCan('use:ai');
  const minutes = session.minutes?.trim() ?? '';
  if (!mayUseAi || !minutes) return null;
  return (
    <SessionAiCard
      sessionId={session.id}
      offer={wordCount(minutes) > OFFER_WORDS}
      language={i18n.language.startsWith('ar') ? 'AR' : 'EN'}
      title={t('sessions.ai.title')}
    />
  );
}

function SessionAiCard({
  sessionId,
  offer,
  language,
  title,
}: {
  readonly sessionId: string;
  readonly offer: boolean;
  readonly language: 'AR' | 'EN';
  readonly title: string;
}) {
  const { t } = useTranslation();
  const summaries = useSessionSummaries(sessionId);
  const ask = useRequestSessionSummary(sessionId);
  const [jobId, setJobId] = useState<string | null>(null);
  const clearJob = useCallback(() => setJobId(null), []);
  const summary = summaries.data?.find((s) => s.language === language) ?? null;
  const request = async () => {
    const answer = await ask.mutateAsync(language);
    if ('jobId' in answer) setJobId(answer.jobId);
  };
  let body: React.ReactNode;
  if (summary) body = <SummaryView key={summary.id} summary={summary} />;
  else if (jobId) body = <PendingJob jobId={jobId} onDone={clearJob} />;
  else {
    body = (
      <Flex vertical gap={8}>
        {offer ? <Alert type="info" showIcon title={t('sessions.ai.offer')} /> : null}
        <Button
          icon={<RobotOutlined />}
          loading={ask.isPending}
          onClick={() => void request().catch(() => undefined)}
          data-testid="session-ai-summary"
          style={{ alignSelf: 'flex-start' }}
        >
          {t('sessions.outcome.aiSummary')}
        </Button>
        {ask.isError ? <ApiErrorAlert error={ask.error} /> : null}
      </Flex>
    );
  }
  return (
    <Card size="small" title={title} style={{ marginBlockStart: 16 }} data-testid="session-ai">
      {body}
    </Card>
  );
}
