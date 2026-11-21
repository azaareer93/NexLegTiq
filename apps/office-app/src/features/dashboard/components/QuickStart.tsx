import { CheckCircleFilled, CloseOutlined } from '@ant-design/icons';
import type { DashboardSetup } from '@nexlegtiq/shared-contracts';
import { Illustration } from '@nexlegtiq/shared-ui';
import { Button, Card, Flex, Progress, theme, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useSession } from '../../auth';
import { openQuickCreateCase } from '../../cases';

type Step = keyof DashboardSetup;

/** The checklist's order and where each step is taken (cases-first: hearings and documents live on a case). */
const STEPS: readonly { step: Step; to: string | null }[] = [
  { step: 'client', to: '/clients' },
  { step: 'case', to: null },
  { step: 'hearing', to: '/cases' },
  { step: 'document', to: '/cases' },
  { step: 'colleague', to: '/team' },
  { step: 'aiSummary', to: '/help/ai-summaries' },
];

// shortcut: dismissal is per browser (D-210); move it to the user's onboarding state if it must follow them.
const storageKey = (userId: string) => `nexlegtiq.quickStart.dismissed.${userId}`;

function wasDismissed(userId: string): boolean {
  try {
    return localStorage.getItem(storageKey(userId)) === '1';
  } catch {
    return false;
  }
}

/**
 * The dashboard's quick-start checklist (MVP-109, D-210): six first steps, ticked from the office's own data, until all
 * are done or the user hides it.
 */
export function QuickStart({ setup }: { readonly setup: DashboardSetup }) {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const navigate = useNavigate();
  const userId = useSession((state) => state.user?.id);
  const [dismissed, setDismissed] = useState(() => !userId || wasDismissed(userId));
  const done = STEPS.filter(({ step }) => setup[step]).length;
  if (!userId || dismissed || done === STEPS.length) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(storageKey(userId), '1');
    } catch {
      // Storage refused (private mode): hidden for this visit only.
    }
    setDismissed(true);
  };
  return (
    <Card
      data-testid="quick-start"
      title={t('dashboard.quickStart.title')}
      extra={
        <Button
          type="text"
          icon={<CloseOutlined />}
          aria-label={t('dashboard.quickStart.dismiss')}
          onClick={dismiss}
          data-testid="quick-start-dismiss"
        />
      }
    >
      <Flex gap={16} align="center" wrap>
        <Illustration kind="start" />
        <Flex vertical gap={8} flex="1 1 280px">
          <Typography.Text type="secondary" id="quick-start-progress">
            {t('dashboard.quickStart.progress', { done, total: STEPS.length })}
          </Typography.Text>
          <Progress
            percent={Math.round((done / STEPS.length) * 100)}
            showInfo={false}
            aria-labelledby="quick-start-progress"
          />
          <Flex vertical component="ol" gap={4} style={{ margin: 0, paddingInlineStart: 0 }}>
            {STEPS.map(({ step, to }) => (
              <Flex
                key={step}
                component="li"
                align="center"
                gap={8}
                style={{ listStyle: 'none' }}
                data-testid={`quick-start-${step}`}
                data-done={setup[step]}
              >
                {setup[step] ? (
                  <CheckCircleFilled
                    style={{ color: token.colorSuccess }}
                    aria-label={t('dashboard.quickStart.done')}
                    role="img"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    style={{
                      inlineSize: 14,
                      blockSize: 14,
                      borderRadius: '50%',
                      border: `1px solid ${token.colorBorder}`,
                    }}
                  />
                )}
                {setup[step] ? (
                  <Typography.Text delete type="secondary">
                    {t(`dashboard.quickStart.steps.${step}`)}
                  </Typography.Text>
                ) : (
                  <Button
                    type="link"
                    style={{ paddingInline: 0 }}
                    onClick={() => (to ? void navigate(to) : openQuickCreateCase())}
                  >
                    {t(`dashboard.quickStart.steps.${step}`)}
                  </Button>
                )}
              </Flex>
            ))}
          </Flex>
        </Flex>
      </Flex>
    </Card>
  );
}
