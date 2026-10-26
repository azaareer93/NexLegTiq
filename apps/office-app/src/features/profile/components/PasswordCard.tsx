import { ChangePasswordRequestSchema } from '@nexlegtiq/shared-contracts';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Button, Card, Flex, Form, Input } from 'antd';
import { useTranslation } from 'react-i18next';

import { parseForm } from '../../auth/forms';
import { useChangePassword } from '../api/use-profile';

interface Values {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}
const FIELDS = ['currentPassword', 'newPassword', 'confirmPassword'];

/** Change the own password (D-086): other sessions end, this one stays; a wrong current password lands on its field. */
export function PasswordCard(): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<Values>();
  const change = useChangePassword();

  const submit = ({ confirmPassword, ...values }: Values) => {
    const body = parseForm(ChangePasswordRequestSchema, values, form, translateKey);
    if (!body) return;
    if (confirmPassword !== body.newPassword) {
      form.setFields([
        { name: 'confirmPassword', errors: [translateKey('validation.password.mismatch')] },
      ]);
      return;
    }
    change.mutate(body, {
      onSuccess: () => {
        form.resetFields();
        void message.success(t('profile.password.changed'));
      },
      onError: (error) => applyToForm(form, error, FIELDS),
    });
  };

  return (
    <Card title={t('profile.password.title')} data-testid="profile-password">
      <Form form={form} layout="vertical" noValidate requiredMark={false} onFinish={submit}>
        <ApiErrorAlert error={change.error} fields={FIELDS} testId="profile-password-error" />
        <Form.Item name="currentPassword" label={t('profile.password.current')}>
          <Input.Password
            dir="ltr"
            autoComplete="current-password"
            data-testid="profile-current-password"
          />
        </Form.Item>
        <Form.Item name="newPassword" label={t('profile.password.next')}>
          <Input.Password
            dir="ltr"
            autoComplete="new-password"
            data-testid="profile-new-password"
          />
        </Form.Item>
        <Form.Item name="confirmPassword" label={t('profile.password.confirm')}>
          <Input.Password
            dir="ltr"
            autoComplete="new-password"
            data-testid="profile-confirm-password"
          />
        </Form.Item>
        <Flex justify="end">
          <Button
            type="primary"
            htmlType="submit"
            loading={change.isPending}
            data-testid="profile-password-save"
          >
            {t('profile.password.submit')}
          </Button>
        </Flex>
      </Form>
    </Card>
  );
}
