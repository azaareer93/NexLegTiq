import type { OnboardingState } from '@nexlegtiq/shared-contracts';
import type { OnboardingStep } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, LoadingSkeleton, PageHeader } from '@nexlegtiq/shared-ui';
import { Button, Card, Flex, Progress, Typography } from 'antd';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useOfficeProfile } from '../../settings/api/use-office';
import { advance, stepsFor, useOnboarding, useSaveOnboarding } from '../api/use-onboarding';
import { StepBody } from '../components/StepBody';

const FRESH: OnboardingState = { status: 'ACTIVE', step: 'ACCOUNT', done: [] };

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
          <Button type="link" onClick={dismiss} data-testid="onboarding-dismiss">
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
          <StepBody step={step} steps={steps} done={state.done} />
          {save.isError ? <ApiErrorAlert error={save.error} /> : null}
          <Flex gap={8} justify="space-between" wrap>
            <Button
              disabled={index === 0}
              onClick={() => go(index - 1, false)}
              data-testid="onboarding-back"
            >
              {t('onboarding.back')}
            </Button>
            <Flex gap={8}>
              {last ? null : (
                <Button onClick={() => go(index + 1, false)} data-testid="onboarding-skip">
                  {t('onboarding.skip')}
                </Button>
              )}
              <Button
                type="primary"
                loading={save.isPending}
                onClick={() => (last ? finish() : go(index + 1, true))}
                data-testid="onboarding-next"
              >
                {last ? t('onboarding.finish') : t('onboarding.next')}
              </Button>
            </Flex>
          </Flex>
        </Flex>
      </Card>
    </section>
  );
}
