import {
  CheckCircleFilled,
  MinusCircleOutlined,
  UploadOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import type { OnboardingStep } from '@nexlegtiq/shared-types';
import { Button, Card, Flex, List, Result, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { CasePicker } from './CasePicker';
import { OfficeStep } from './OfficeStep';
import { openQuickCreateCase } from '../../cases';
import { useCase } from '../../cases/api/use-cases';
import { UploadPanel } from '../../cases/documents/UploadPanel';
import { useFolders } from '../../cases/documents/use-documents';
import { CreateSessionForm } from '../../cases/sessions/SessionForms';
import { InviteModal } from '../../team/components/InviteModal';

const TOUR = ['cases', 'calendar', 'tasks', 'ai'] as const;
const NEXT_LINKS = [
  { key: 'cases', to: '/cases' },
  { key: 'calendar', to: '/calendar' },
  { key: 'team', to: '/team' },
  { key: 'settings', to: '/settings' },
] as const;

function Hint({ step }: { readonly step: OnboardingStep }) {
  const { t } = useTranslation();
  return (
    <Typography.Paragraph type="secondary">{t(`onboarding.${step}.hint`)}</Typography.Paragraph>
  );
}

function InviteStep() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Hint step="INVITE" />
      <Button
        icon={<UserAddOutlined />}
        onClick={() => setOpen(true)}
        data-testid="onboarding-invite"
      >
        {t('onboarding.INVITE.action')}
      </Button>
      {open ? <InviteModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function HearingForm({ fileId }: { readonly fileId: string }) {
  const { t } = useTranslation();
  const file = useCase(fileId);
  const [added, setAdded] = useState(false);
  if (!file.data) return null;
  if (added) return <Result status="success" title={t('onboarding.HEARING.added')} />;
  return <CreateSessionForm file={file.data} onDone={() => setAdded(true)} />;
}

function DocumentUpload({ fileId }: { readonly fileId: string }) {
  const { t } = useTranslation();
  const folders = useFolders(fileId).data ?? [];
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        icon={<UploadOutlined />}
        onClick={() => setOpen(true)}
        data-testid="onboarding-upload"
      >
        {t('onboarding.DOCUMENT.action')}
      </Button>
      <UploadPanel
        open={open}
        fileId={fileId}
        folders={folders}
        defaultFolderId={null}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** Steps that work on a case: pick one (the newest first), then the hearing form or the upload. */
function OnCase({ step }: { readonly step: 'HEARING' | 'DOCUMENT' }) {
  const [fileId, setFileId] = useState<string>();
  return (
    <Flex vertical gap={12}>
      <Hint step={step} />
      <CasePicker value={fileId} onChange={setFileId} testId={`onboarding-case-${step}`} />
      {fileId && step === 'HEARING' ? <HearingForm key={fileId} fileId={fileId} /> : null}
      {fileId && step === 'DOCUMENT' ? <DocumentUpload fileId={fileId} /> : null}
    </Flex>
  );
}

function Done({
  steps,
  done,
}: {
  readonly steps: readonly OnboardingStep[];
  readonly done: readonly OnboardingStep[];
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Flex vertical gap={16}>
      <List
        size="small"
        data-testid="onboarding-checklist"
        dataSource={steps.filter((s) => s !== 'DONE')}
        renderItem={(s) => (
          <List.Item>
            <Flex gap={8} align="center">
              {done.includes(s) ? (
                <CheckCircleFilled aria-hidden style={{ color: 'var(--ant-color-success)' }} />
              ) : (
                <MinusCircleOutlined aria-hidden />
              )}
              <span>{t(`onboarding.steps.${s}`)}</span>
              <Typography.Text type="secondary">
                {done.includes(s) ? t('onboarding.DONE.finished') : t('onboarding.DONE.skipped')}
              </Typography.Text>
            </Flex>
          </List.Item>
        )}
      />
      <Typography.Text strong>{t('onboarding.DONE.next')}</Typography.Text>
      <Flex gap={8} wrap>
        {NEXT_LINKS.map((l) => (
          <Button key={l.key} onClick={() => void navigate(l.to)}>
            {t(`onboarding.DONE.links.${l.key}`)}
          </Button>
        ))}
      </Flex>
    </Flex>
  );
}

/** What each step shows (D-181); every action reuses the app's own forms. */
export function StepBody({
  step,
  steps,
  done,
  onUnsaved,
}: {
  readonly step: OnboardingStep;
  readonly steps: readonly OnboardingStep[];
  readonly done: readonly OnboardingStep[];
  readonly onUnsaved: (unsaved: boolean) => void;
}) {
  const { t } = useTranslation();
  switch (step) {
    case 'ACCOUNT':
      return (
        <Result
          status="success"
          title={t('onboarding.ACCOUNT.title')}
          subTitle={t('onboarding.ACCOUNT.hint')}
        />
      );
    case 'OFFICE':
      return (
        <>
          <Hint step="OFFICE" />
          <OfficeStep onUnsaved={onUnsaved} />
        </>
      );
    case 'INVITE':
      return <InviteStep />;
    case 'TOUR':
      return (
        <Flex gap={12} wrap>
          {TOUR.map((k) => (
            <Card
              key={k}
              size="small"
              title={t(`onboarding.TOUR.${k}.title`)}
              style={{ flex: '1 1 220px' }}
            >
              {t(`onboarding.TOUR.${k}.body`)}
            </Card>
          ))}
        </Flex>
      );
    case 'CASE':
      return (
        <>
          <Hint step="CASE" />
          <Button
            type="primary"
            onClick={() => openQuickCreateCase()}
            data-testid="onboarding-new-case"
          >
            {t('onboarding.CASE.action')}
          </Button>
        </>
      );
    case 'HEARING':
    case 'DOCUMENT':
      return <OnCase step={step} />;
    case 'DONE':
      return <Done steps={steps} done={done} />;
  }
}
