import type { ErrorCode } from '@nexlegtiq/shared-types';
import { Button, Empty, Flex, Result, Skeleton, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Ltr } from '../Bidi/Bidi';

export interface EmptyStateProps {
  /** Defaults to "Nothing here yet". */
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  /** Usually the button that creates the first item. */
  readonly action?: ReactNode;
}

/** An empty list or page, with an optional way forward. */
export function EmptyState({ title, description, action }: EmptyStateProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <Flex vertical gap={4}>
          <Typography.Text strong>{title ?? t('common.states.empty')}</Typography.Text>
          {description ? <Typography.Text type="secondary">{description}</Typography.Text> : null}
        </Flex>
      }
    >
      {action}
    </Empty>
  );
}

export interface ErrorStateProps {
  /** The API error code; its `errors.<CODE>` text is shown. Without one, a generic message. */
  readonly code?: ErrorCode;
  /** The request id from the error response (D-076), shown so support can find the server logs. */
  readonly requestId?: string;
  readonly onRetry?: () => void;
}

/** A failed load or action: what went wrong, a reference for support and a retry. */
export function ErrorState({ code, requestId, onRetry }: ErrorStateProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div role="alert">
      <Result
        status="warning"
        title={code ? t(`errors.${code}`) : t('common.states.error')}
        subTitle={
          requestId ? (
            <>
              {t('common.states.reference')} <Ltr>{requestId}</Ltr>
            </>
          ) : null
        }
        extra={onRetry ? <Button onClick={onRetry}>{t('common.actions.retry')}</Button> : null}
      />
    </div>
  );
}

export interface LoadingSkeletonProps {
  /** Paragraph lines to suggest; default 3. */
  readonly rows?: number;
}

/** Placeholder while content loads; announced to screen readers as loading. */
export function LoadingSkeleton({ rows = 3 }: LoadingSkeletonProps): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" aria-label={t('common.states.loading')}>
      {/* Decorative: AntD draws the title bar as an empty heading, which a screen reader would announce. */}
      <div aria-hidden="true">
        <Skeleton active title paragraph={{ rows }} />
      </div>
    </div>
  );
}
