import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Button, Card, Flex, Form } from 'antd';
import type { Rule } from 'antd/es/form';
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';

import { parseForm, zodRule } from '../../auth/forms';

export type FormValues = Record<string, unknown>;

/** The fields whose value differs from what the server sent (arrays compared as sets: reminder days are sorted). */
export function changedValues(initial: FormValues, values: FormValues): FormValues {
  const norm = (value: unknown) =>
    JSON.stringify(Array.isArray(value) ? [...(value as number[])].sort() : value);
  return Object.fromEntries(
    Object.keys(initial)
      .filter((key) => norm(values[key]) !== norm(initial[key]))
      .map((key) => [key, values[key]]),
  );
}

export interface SettingsSectionProps {
  readonly title: string;
  readonly testId: string;
  /** The form's values as the server has them (`null` shown as an empty field). */
  readonly initial: FormValues;
  /** The partial update contract: what is sent is validated with it first. */
  readonly schema: z.ZodType;
  /** The section's mutation (`mutateAsync` of `useUpdateProfile` / `useUpdateSettings`). */
  readonly save: {
    readonly mutateAsync: (body: never) => Promise<unknown>;
    readonly isPending: boolean;
    readonly error: Error | null;
  };
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly children: ReactNode;
}

/**
 * One card of the settings page (D-125): its own form, saving only the fields that changed to one endpoint, with
 * "discard" to go back to the saved values. It reports whether it has unsaved changes, for the page's guard.
 */
export function SettingsSection({
  title,
  testId,
  initial,
  schema,
  save,
  onDirtyChange,
  children,
}: SettingsSectionProps): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<FormValues>();
  const fields = Object.keys(initial);
  const saved = JSON.stringify(initial);

  // The server's answer is the new starting point.
  useEffect(() => {
    form.resetFields();
    onDirtyChange(false);
  }, [form, saved, onDirtyChange]);

  const isDirty = () =>
    Object.keys(changedValues(initial, form.getFieldsValue(true) as FormValues)).length > 0;

  const submit = (values: FormValues) => {
    const changes = changedValues(initial, values);
    if (Object.keys(changes).length === 0) return;
    const body = parseForm(schema, changes, form, translateKey);
    if (!body) return;
    void save.mutateAsync(body as never).then(
      () => void message.success(t('common.feedback.saved')),
      (error: unknown) => applyToForm(form, error, fields),
    );
  };

  return (
    <Card title={title} data-testid={testId}>
      <Form
        form={form}
        layout="vertical"
        noValidate
        requiredMark={false}
        initialValues={initial}
        onValuesChange={() => onDirtyChange(isDirty())}
        onFinish={submit}
      >
        <ApiErrorAlert error={save.error} fields={fields} testId={`${testId}-error`} />
        {children}
        <Flex gap={8} justify="end">
          <Button
            onClick={() => {
              form.resetFields();
              onDirtyChange(false);
            }}
            disabled={save.isPending}
            data-testid={`${testId}-discard`}
          >
            {t('settings.discard')}
          </Button>
          <Button
            type="primary"
            htmlType="submit"
            loading={save.isPending}
            data-testid={`${testId}-save`}
          >
            {t('common.actions.save')}
          </Button>
        </Flex>
      </Form>
    </Card>
  );
}

/** The field's rules from the section's contract (`zodRule`, D-090). */
export function useFieldRules(shape: Record<string, z.ZodType>): (field: string) => Rule[] {
  const { translateKey } = useApiErrorHandler();
  return (field) => {
    const schema = shape[field];
    return schema ? zodRule(schema, translateKey) : [];
  };
}

/** Server values as form values: an empty optional field is `''` in an input, `null` on the server. */
export const formValues = (row: Record<string, unknown>, keys: readonly string[]): FormValues =>
  Object.fromEntries(keys.map((key) => [key, row[key] ?? '']));
