import { ApiError } from '@nexlegtiq/shared-api-client';
import type { FormInstance } from 'antd';
import type { Rule } from 'antd/es/form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';

/** `validation.*` keys from the contracts and the API's `details`; anything unknown gets the generic message. */
export function useMessage(): (key: string) => string {
  const { t, i18n } = useTranslation();
  const translate = t as unknown as (key: string) => string;
  return (key) => translate(i18n.exists(key as never) ? key : 'common.states.error');
}

/** Contract messages are `validation.*` keys; Zod's own messages (a value of the wrong type) only arise for empty fields. */
const keyOf = (issue: z.core.$ZodIssue): string => (issue.message.startsWith('validation.') ? issue.message : 'validation.required');

/** AntD rules from a contract field schema: the same validation and messages as the API (shared-contracts). */
export function zodRule(schema: z.ZodType, message: (key: string) => string): Rule[] {
  return [
    // AntD skips custom validators on empty fields unless one rule is `required`: required = the contract rejects "empty".
    { required: !schema.safeParse(undefined).success, message: message('validation.required') },
    {
      validator: async (_rule, value: unknown) => {
        // Empty is the `required` rule's call (and fine for optional fields).
        if (value === undefined || value === null || value === '') return;
        const result = schema.safeParse(value);
        if (!result.success) {
          const issue = result.error.issues[0];
          throw new Error(message(issue ? keyOf(issue) : 'validation.required'));
        }
      },
    },
  ];
}

/**
 * Validates the whole form with its contract (cross-field rules such as "passwords match" included). Returns the parsed
 * value, or null after putting each issue on its field.
 */
export function parseForm<S extends z.ZodType>(
  schema: S,
  values: unknown,
  form: FormInstance,
  message: (key: string) => string,
): z.output<S> | null {
  const result = schema.safeParse(values);
  if (result.success) {
    return result.data;
  }
  form.setFields(result.error.issues.map((issue) => ({ name: issue.path.map(String), errors: [message(keyOf(issue))] })));
  return null;
}

/** Puts the API's field errors (VAL-001 `details`) on the form fields it has; `isFieldError` tells if that was all. */
export function applyServerErrors(form: FormInstance, error: unknown, fields: readonly string[], message: (key: string) => string): void {
  if (error instanceof ApiError) {
    const onFields = error.details.filter((detail) => fields.includes(detail.field));
    form.setFields(onFields.map((detail) => ({ name: detail.field, errors: [message(detail.message)] })));
  }
}

/** True when the failure is fully explained by field errors on the form (no banner needed). */
export function isFieldError(error: unknown, fields: readonly string[]): boolean {
  return error instanceof ApiError && error.details.length > 0 && error.details.every((detail) => fields.includes(detail.field));
}

/**
 * Only same-app paths: `next=//evil.test`, `https://…` or `/%09/evil.test` (browsers drop tabs and newlines from URLs)
 * would turn sign-in into an open redirect. Parsed like the browser does, then checked for the same origin.
 */
export function safeNext(next: string | null): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must be refused.
  if (!next || !/^\/(?![/\\])/.test(next) || /[\u0000-\u001f\u007f]/.test(next)) {
    return '/';
  }
  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}
