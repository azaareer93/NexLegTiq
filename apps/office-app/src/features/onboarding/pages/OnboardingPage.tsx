import type { OnboardingState } from '@nexlegtiq/shared-contracts';
import type { OnboardingStep } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, LoadingSkeleton, PageHeader } from '@nexlegtiq/shared-ui';
import { Button, Card, Flex, Progress, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useOfficeProfile } from '../../settings/api/use-office';
import { advance, stepsFor, useOnboarding, useSaveOnboarding } from '../api/use-onboarding';
import { StepBody } from '../components/StepBody';

const FRESH: OnboardingState = { status: 'ACTIVE', step: 'ACCOUNT', done: [] };

/** Back, Skip and Next; nothing else is clickable while a save is on its way (saves never overlap). */
function Footer({
  first,
  last,
  pending,
  unsaved,
  onBack,
  onSkip,
  onNext,
}: {
  readonly first: boolean;
  readonly last: boolean;
  readonly pending: boolean;
  readonly unsaved: boolean;
  readonly onBack: () => void;
  readonly onSkip: () => void;
  readonly onNext: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Flex gap={8} justify="space-between" wrap>
      <Button disabled={first || pending} onClick={onBack} data-testid="onboarding-back">
        {t('onboarding.back')}
      </Button>
      <Flex gap={8}>
        {last ? null : (
          <Button disabled={pending} onClick={onSkip} data-testid="onboarding-skip">
            {t('onboarding.skip')}
          </Button>
        )}
        <Button
          type="primary"
          loading={pending}
          // Office changes not saved yet would be marked done without being kept.
          disabled={unsaved}
          onClick={onNext}
          data-testid="onboarding-next"
        >
          {last ? t('onboarding.finish') : t('onboarding.next')}
        </Button>
      </Flex>
    </Flex>
  );
}

/**
 * `/onboarding` (MVP-108, D-181): the setup wizard, "Step n of N" with back, skip and next. Progress lives on the server,
 * so a reload or another device resumes where it was; opening it again (the profile menu) makes it active again.
 */
export function OnboardingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const office = useOfficeProfile();
  const onboarding = useOnboarding();
  const save = useSaveOnboarding();
  const loaded = onboarding.data;
  const state: OnboardingState = loaded?.state ?? FRESH;
  // Reopened after a dismissal or the end, or never offered: active again, once per visit.
  const [unsaved, setUnsaved] = useState(false);
  const reopened = useRef(false);
  const { mutate } = save;
  useEffect(() => {
    if (!loaded || reopened.current) return;
    reopened.current = true;
    const current = loaded.state;
    if (current === null) mutate(FRESH);
    else if (current.status !== 'ACTIVE') mutate({ ...current, status: 'ACTIVE', step: 'ACCOUNT' });
  }, [loaded, mutate]);

  if (onboarding.isError) return <ApiErrorAlert error={onboarding.error} />;
  if (!loaded || !office.data) return <LoadingSkeleton rows={6} />;
  const steps = stepsFor(office.data.accountType);
  const index = Math.max(0, steps.indexOf(state.step));
  const step = steps[index] as OnboardingStep;
  const last = index === steps.length - 1;
  const go = (to: number, finished: boolean) =>
    save.mutate(advance(state, step, steps[to] as OnboardingStep, finished));
  const finish = () =>
    save.mutate(
      {
        status: 'COMPLETED',
        step,
        done: state.done.includes(step) ? state.done : [...state.done, step],
      },
      { onSuccess: () => void navigate('/', { replace: true }) },
    );
  const dismiss = () =>
    save.mutate(
      { ...state, status: 'DISMISSED' },
      { onSuccess: () => void navigate('/', { replace: true }) },
    );

  return (
    <section data-testid="page-onboarding">
      <PageHeader
        title={t('onboarding.title')}
        extra={
          <Button
            type="link"
            disabled={save.isPending}
            onClick={dismiss}
            data-testid="onboarding-dismiss"
          >
            {t('onboarding.dismiss')}
          </Button>
        }
      />
      <Card>
        <Flex vertical gap={16}>
          <div>
            <Typography.Text type="secondary" data-testid="onboarding-progress">
              {t('onboarding.progress', { n: index + 1, total: steps.length })}
            </Typography.Text>
            <Progress
              percent={Math.round(((index + 1) / steps.length) * 100)}
              showInfo={false}
              aria-label={t('onboarding.progress', { n: index + 1, total: steps.length })}
            />
          </div>
          <Typography.Title level={2} style={{ margin: 0 }} data-testid="onboarding-step-title">
            {t(`onboarding.steps.${step}`)}
          </Typography.Title>
          <StepBody step={step} steps={steps} done={state.done} onUnsaved={setUnsaved} />
          {unsaved ? (
            <Typography.Text type="warning" data-testid="onboarding-unsaved">
              {t('onboarding.unsaved')}
            </Typography.Text>
          ) : null}
          {save.isError ? <ApiErrorAlert error={save.error} /> : null}
          <Footer
            first={index === 0}
            last={last}
            pending={save.isPending}
            unsaved={unsaved}
            onBack={() => go(index - 1, false)}
            onSkip={() => {
              setUnsaved(false);
              go(index + 1, false);
            }}
            onNext={() => (last ? finish() : go(index + 1, true))}
          />
        </Flex>
      </Card>
    </section>
  );
}
