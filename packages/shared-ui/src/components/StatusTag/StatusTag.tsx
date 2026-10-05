import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  MinusCircleOutlined,
  MinusOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { Priority } from '@nexlegtiq/shared-types';
import { Tag } from 'antd';
import type { TagProps } from 'antd';
import type { ComponentType, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export type StatusTone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

/** An icon component; it is rendered `aria-hidden` (the text carries the meaning). */
type TagIcon = ComponentType<{ 'aria-hidden'?: boolean }>;

const TONES: Record<StatusTone, { color: TagProps['color']; icon: TagIcon }> = {
  success: { color: 'success', icon: CheckCircleOutlined },
  warning: { color: 'warning', icon: ExclamationCircleOutlined },
  error: { color: 'error', icon: CloseCircleOutlined },
  info: { color: 'processing', icon: InfoCircleOutlined },
  neutral: { color: 'default', icon: MinusCircleOutlined },
};

export interface StatusTagProps {
  readonly tone: StatusTone;
  /** The status label, already translated (e.g. `t('enums.fileStatus.OPEN')`). */
  readonly children: ReactNode;
  /** Replaces the tone's icon. */
  readonly icon?: TagIcon;
}

/** A status shown by colour, icon and text together, never colour alone (WCAG 1.4.1). */
export function StatusTag({ tone, children, icon }: StatusTagProps): React.JSX.Element {
  const Icon = icon ?? TONES[tone].icon;
  return (
    <Tag color={TONES[tone].color} icon={<Icon aria-hidden />}>
      {children}
    </Tag>
  );
}

const PRIORITY_LOOK: Record<Priority, { tone: StatusTone; icon: TagIcon }> = {
  LOW: { tone: 'neutral', icon: ArrowDownOutlined },
  MEDIUM: { tone: 'info', icon: MinusOutlined },
  HIGH: { tone: 'warning', icon: ArrowUpOutlined },
  URGENT: { tone: 'error', icon: ThunderboltOutlined },
};

/** A case or task priority with its translated label. */
export function PriorityTag({ priority }: { readonly priority: Priority }): React.JSX.Element {
  const { t } = useTranslation();
  const look = PRIORITY_LOOK[priority];
  return (
    <StatusTag tone={look.tone} icon={look.icon}>
      {t(`enums.priority.${priority}`)}
    </StatusTag>
  );
}
