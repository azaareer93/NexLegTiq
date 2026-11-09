import { casesApi } from '@nexlegtiq/shared-api-client';
import type { AiSummaryListItem, AiUsageSummary, Case } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import type { Role } from '@nexlegtiq/shared-types';
import {
  AiDisclaimer,
  ApiErrorAlert,
  EmptyState,
  ErrorState,
  isApiError,
  useFormat,
  LoadingSkeleton,
  useApiErrorHandler,
} from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Flex, Tag } from 'antd';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GeneratePanel } from './GeneratePanel';
import { SummaryCard } from './SummaryCard';
import { aiKeys, useAiJob, useAiUsage, useFileSummaries, useRequestSummary } from './use-ai';
import { apiClient } from '../auth';
import { useDocuments } from '../cases/documents/use-documents';
import { canWriteConfidentialNotes } from '../cases/file-page';
import { noteKeys } from '../cases/notes/use-notes';

const cases = casesApi(apiClient);
const NOTE_MAX = 10_000;

type Language = AiSummaryListItem['language'];
interface Pending {
  readonly jobId: string;
  readonly name: string;
}

const codeOf = (error: unknown): string | undefined => (isApiError(error) ? error.code : undefined);

/** A queued summary: followed by `ai.job.*` events and, as the fallback, by polling; a failure stays until dismissed. */
function PendingCard({
  job,
  onDone,
}: {
  readonly job: Pending;
  readonly onDone: (jobId: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data } = useAiJob(job.jobId);
  const succeeded = data?.status === 'SUCCEEDED';
  useEffect(() => {
    if (!succeeded) return;
    void queryClient.invalidateQueries({ queryKey: aiKeys.summariesAll });
    void queryClient.invalidateQueries({ queryKey: aiKeys.usage });
    onDone(job.jobId);
  }, [succeeded, queryClient, onDone, job.jobId]);
  const name = isolate(job.name);
  if (data?.status === 'FAILED') {
    return (
      <Flex vertical gap={8} data-testid={`ai-failed-${job.jobId}`}>
        <Alert type="error" showIcon title={t('aiSummary.failed.title', { name })} />
        <ApiErrorAlert error={{ code: data.errorCode ?? 'SYS-001' }} />
        <AiDisclaimer />
        <Button onClick={() => onDone(job.jobId)} data-testid={`ai-dismiss-${job.jobId}`}>
          {t('aiSummary.failed.dismiss')}
        </Button>
      </Flex>
    );
  }
  return (
    <Card size="small" data-testid={`ai-pending-${job.jobId}`} aria-busy>
      <Flex vertical gap={8}>
        <span role="status">{t('aiSummary.pending', { name })}</span>
        <AiDisclaimer />
      </Flex>
    </Card>
  );
}

/** The plain-text note a summary becomes (D-154): no formatting, within the note limit. */
function noteBody(t: TFunction, item: AiSummaryListItem): string {
  const lists: [string, string[]][] = [
    [t('aiSummary.summary.keyFacts'), item.keyFacts],
    [t('aiSummary.summary.legalIssues'), item.keyLegalIssues],
    [t('aiSummary.summary.parties'), item.parties],
  ];
  return [
    t('aiSummary.copy.heading', {
      name: item.source.name,
      language: t(`aiSummary.language.${item.language}`),
    }),
    item.summary,
    ...lists.flatMap(([title, entries]) =>
      entries.length ? [`${title}:`, ...entries.map((e) => `- ${e}`)] : [],
    ),
  ]
    .join('\n')
    .slice(0, NOTE_MAX);
}

function QuotaBadge({ usage }: { readonly usage: AiUsageSummary | undefined }) {
  const { t } = useTranslation();
  const format = useFormat();
  if (!usage) return null;
  return (
    <Tag data-testid="ai-quota">
      {usage.quota === null
        ? t('aiSummary.quota.unlimited', {
            count: usage.used,
            formatted: format.number(usage.used),
          })
        : t('aiSummary.quota.badge', {
            count: usage.used,
            formatted: format.number(usage.used),
            quota: format.number(usage.quota),
          })}
    </Tag>
  );
}

interface BodyProps {
  readonly fileId: string;
  readonly canWriteNotes: boolean;
  readonly canConfidential: boolean;
  readonly items: readonly AiSummaryListItem[];
  readonly usage: AiUsageSummary | undefined;
  readonly onOff: () => void;
}

function AiBody({ fileId, canWriteNotes, canConfidential, items, usage, onOff }: BodyProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const queryClient = useQueryClient();
  const documents = useDocuments(fileId, { status: 'READY', limit: '100' });
  const request = useRequestSummary(fileId);
  const [pending, setPending] = useState<Pending[]>([]);
  const [quotaHit, setQuotaHit] = useState(false);
  const [copying, setCopying] = useState(false);
  const drop = useCallback(
    (jobId: string) => setPending((all) => all.filter((p) => p.jobId !== jobId)),
    [],
  );

  const names = new Map<string, string>([
    ...(documents.data?.items ?? []).map((d) => [d.id, d.name] as const),
    ...items.map((s) => [s.source.id, s.source.name] as const),
  ]);

  const ask = (id: string, lang: Language, force: boolean) =>
    request.mutate(
      { sourceType: 'DOCUMENT', sourceId: id, language: lang, force },
      {
        onSuccess: (answer) => {
          setQuotaHit(false);
          if ('jobId' in answer) {
            setPending((all) =>
              all.some((p) => p.jobId === answer.jobId)
                ? all
                : [
                    ...all,
                    { jobId: answer.jobId, name: names.get(id) ?? t('aiSummary.unnamedDocument') },
                  ],
            );
          }
        },
        onError: (error) => {
          const code = codeOf(error);
          if (code === 'AI-005') onOff();
          else if (code === 'AUTH-103') setQuotaHit(true);
          else notify(error);
        },
      },
    );

  // A confidential document's summary becomes a confidential note, which only the office manager or the file's people may write (D-154).
  const mayCopy = (item: AiSummaryListItem) =>
    canWriteNotes && (canConfidential || !item.source.isConfidential);
  const copy = (item: AiSummaryListItem) => {
    setCopying(true);
    cases
      .addNote(fileId, {
        body: noteBody(t, item),
        isConfidential: item.source.isConfidential,
        pinned: false,
      })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: noteKeys.file(fileId) });
        void message.success(t('aiSummary.copy.done'));
      })
      .catch(notify)
      .finally(() => setCopying(false));
  };

  return (
    <Flex vertical gap={16} data-testid="ai-tab">
      <Flex gap={8} wrap align="start" justify="space-between">
        <GeneratePanel
          documents={documents.data?.items ?? []}
          loading={request.isPending}
          onAsk={(id, lang) => ask(id, lang, false)}
        />
        <QuotaBadge usage={usage} />
      </Flex>
      {quotaHit || usage?.remaining === 0 ? (
        <Alert type="warning" showIcon title={t('aiSummary.quota.hint')} data-testid="ai-upgrade" />
      ) : null}
      {pending.map((job) => (
        <PendingCard key={job.jobId} job={job} onDone={drop} />
      ))}
      {items.length === 0 && pending.length === 0 ? (
        <>
          <EmptyState
            title={t('aiSummary.empty.title')}
            description={t('aiSummary.empty.description')}
          />
          <AiDisclaimer />
        </>
      ) : (
        items.map((item) => (
          <SummaryCard
            key={item.id}
            item={item}
            busy={request.isPending}
            onRequest={(lang, force) => ask(item.source.id, lang, force)}
            onCopyToNote={mayCopy(item) ? () => copy(item) : null}
            copying={copying}
          />
        ))
      )}
    </Flex>
  );
}

/** The file's AI tab (D-148): summaries of its documents, a picker to summarise another, quota and states. */
export function AiTab({
  file,
  user,
  canWriteNotes,
}: {
  readonly file: Case;
  readonly user: { readonly id: string; readonly role: Role };
  /** Edit rights on a file that is not archived: copying a summary into a note writes one. */
  readonly canWriteNotes: boolean;
}) {
  const fileId = file.id;
  const canConfidential = canWriteConfidentialNotes(file, user);
  const { t } = useTranslation();
  const usage = useAiUsage();
  const summaries = useFileSummaries(fileId);
  const [off, setOff] = useState(false);

  const code = codeOf(summaries.error);
  if (off || codeOf(usage.error) === 'AI-005' || code === 'AI-005') {
    return <Alert type="info" showIcon title={t('aiSummary.disabled')} data-testid="ai-disabled" />;
  }
  if (summaries.isPending) return <LoadingSkeleton />;
  if (summaries.isError) {
    return (
      <ErrorState
        code={code && isErrorCode(code) ? code : undefined}
        requestId={isApiError(summaries.error) ? summaries.error.requestId : undefined}
        onRetry={() => void summaries.refetch()}
      />
    );
  }
  return (
    <AiBody
      fileId={fileId}
      canWriteNotes={canWriteNotes}
      canConfidential={canConfidential}
      items={summaries.data}
      usage={usage.data}
      onOff={() => setOff(true)}
    />
  );
}
