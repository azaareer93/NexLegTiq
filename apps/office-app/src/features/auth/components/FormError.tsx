import { ApiError } from '@nexlegtiq/shared-api-client';
import { Alert } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { isFieldError, useMessage } from '../forms';

export interface FormErrorProps {
  readonly error: unknown;
  /** Fields that show their own API errors (VAL-001 details); then no banner is needed. */
  readonly fields?: readonly string[];
  /** A way forward next to the message, e.g. "sign in" after a signup that may have gone through. */
  readonly action?: ReactNode;
  readonly testId?: string;
}

/** The banner of a failed form: `errors.<CODE>` in the user's language, plus how long to wait when the API says so. */
export function FormError({ error, fields = [], action, testId }: FormErrorProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const message = useMessage();
  if (!error || isFieldError(error, fields)) {
    return null;
  }
  const apiError = error instanceof ApiError ? error : null;
  const text = message(apiError ? `errors.${apiError.code}` : 'common.states.error');
  const wait = apiError?.retryAfter ? ` ${t('auth.retryAfter', { count: apiError.retryAfter })}` : '';
  return <Alert type="error" showIcon role="alert" title={text + wait} action={action} data-testid={testId} />;
}
