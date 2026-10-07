import { isErrorCode } from '@nexlegtiq/shared-types';
import type { ApiErrorDetail } from '@nexlegtiq/shared-types';
import { Alert, App, notification as staticNotification } from 'antd';
import type { FormInstance } from 'antd';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Ltr } from '../Bidi/Bidi';

/**
 * What the UI needs of a failed request: the shape of shared-api-client's `ApiError` (D-089), matched structurally because
 * shared-ui may not depend on the API client (Nx boundaries). `code` may be one this build does not know (a newer API).
 */
export interface ApiErrorLike {
  readonly code: string;
  readonly details?: readonly ApiErrorDetail[];
  /** D-076 correlation id (the API client keeps only well-formed ones), shown so support can find the server logs. */
  readonly requestId?: string;
  /** Seconds to wait, from `Retry-After`. */
  readonly retryAfter?: number;
}

const CODE = /^[A-Z]+-\d{3}$/;

export const isApiError = (error: unknown): error is ApiErrorLike =>
  typeof error === 'object' &&
  error !== null &&
  typeof (error as { code?: unknown }).code === 'string' &&
  CODE.test((error as { code: string }).code);

/** Failures the user cannot fix by changing what they did (incl. the AI provider down or failing): worth a reference for support. */
const SUPPORT_CODE = /^(SYS|DB|EXT|STO)-|^AI-00[14]$/;

export interface ApiErrorHandler {
  /** `errors.<CODE>` in the user's language (plus how long to wait when the API says so); the generic message otherwise. */
  readonly messageOf: (error: unknown) => string;
  /** The support reference to show, when the user cannot fix the failure themselves (or its code is unknown). */
  readonly referenceOf: (error: unknown) => string | undefined;
  /** A `validation.*` key (contracts, API `details`) in the user's language; unknown keys get the generic message. */
  readonly translateKey: (key: string) => string;
  /** Puts the API's field errors (VAL-001 `details`) on the form fields listed; true when they explain the whole failure. */
  readonly applyToForm: (form: FormInstance, error: unknown, fields: readonly string[]) => boolean;
  /** A failed action without a form of its own (delete, upload, a button): a notification with the reference. */
  readonly notify: (error: unknown) => void;
}

/** True when the failure is fully explained by field errors on the form (no banner needed). */
export const isFieldError = (error: unknown, fields: readonly string[]): boolean =>
  isApiError(error) &&
  !!error.details?.length &&
  error.details.every((detail) => fields.includes(detail.field));

/** Every known code has AR and EN text (D-087 parity test), so "known" is the shared-types list. */
const isKnown = (error: unknown): error is ApiErrorLike =>
  isApiError(error) && isErrorCode(error.code);

function Reference({ id }: { readonly id: string }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <>
      {t('common.states.reference')}: <Ltr>{id}</Ltr>
    </>
  );
}

/**
 * Maps API failures to what the user sees (MVP-120, D-093). Stable between renders while the language does not change, so its
 * functions can be effect dependencies. `notify` follows the theme and direction inside `NexProvider` (AntD `App`).
 */
export function useApiErrorHandler(): ApiErrorHandler {
  const { t, i18n } = useTranslation();
  const app = App.useApp();
  // Outside AntD's `App` the context holds an empty object: fall back to the static API rather than throw.
  const notification =
    typeof app.notification.error === 'function' ? app.notification : staticNotification;
  const language = i18n.language;

  return useMemo(() => {
    // Keys built at runtime (`errors.<CODE>`, API `validation.*`) cannot be typed: each is known or checked with `i18n.exists`.
    const translate = t as unknown as (key: string, options?: Record<string, unknown>) => string;
    const translateKey = (key: string) =>
      translate(i18n.exists(key as never) ? key : 'common.states.error');
    const messageOf = (error: unknown) => {
      if (!isKnown(error)) return translate('common.states.error');
      const wait =
        error.retryAfter === undefined
          ? ''
          : ` ${translate('common.states.retryAfter', { count: error.retryAfter })}`;
      return translate(`errors.${error.code}`) + wait;
    };
    const referenceOf = (error: unknown) =>
      isApiError(error) && error.requestId && (!isKnown(error) || SUPPORT_CODE.test(error.code))
        ? error.requestId
        : undefined;
    return {
      messageOf,
      referenceOf,
      translateKey,
      applyToForm: (form, error, fields) => {
        if (!isApiError(error)) return false;
        const onFields = (error.details ?? []).filter((detail) => fields.includes(detail.field));
        form.setFields(
          onFields.map((detail) => ({
            name: detail.field,
            errors: [translateKey(detail.message)],
          })),
        );
        return isFieldError(error, fields);
      },
      notify: (error) => {
        const reference = referenceOf(error);
        notification.error({
          title: messageOf(error),
          description: reference ? <Reference id={reference} /> : undefined,
          role: 'alert',
        });
      },
    };
    // `language` makes the handler follow a language switch (`t` and `i18n` keep their identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, i18n, notification, language]);
}

export interface ApiErrorAlertProps {
  readonly error: unknown;
  /** Fields that show their own API errors (VAL-001 details); when they explain everything, no banner is shown. */
  readonly fields?: readonly string[];
  /** A way forward next to the message, e.g. "sign in" after a signup that may have gone through. */
  readonly action?: ReactNode;
  readonly testId?: string;
}

/** The banner of a failed form: the message in the user's language, and a support reference for server-side failures. */
export function ApiErrorAlert({
  error,
  fields = [],
  action,
  testId,
}: ApiErrorAlertProps): React.JSX.Element | null {
  const { messageOf, referenceOf } = useApiErrorHandler();
  if (!error || isFieldError(error, fields)) {
    return null;
  }
  const reference = referenceOf(error);
  return (
    <Alert
      type="error"
      showIcon
      role="alert"
      title={messageOf(error)}
      description={reference ? <Reference id={reference} /> : undefined}
      action={action}
      data-testid={testId}
    />
  );
}
