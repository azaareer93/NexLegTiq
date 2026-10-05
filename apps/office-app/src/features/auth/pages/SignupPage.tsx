import { ApiError } from '@nexlegtiq/shared-api-client';
import { RegisterRequestSchema } from '@nexlegtiq/shared-contracts';
import type { RegisterRequest } from '@nexlegtiq/shared-contracts';
import { ACCOUNT_TYPES, JURISDICTIONS, OFFICE_LANGUAGES } from '@nexlegtiq/shared-types';
import { useLanguage } from '@nexlegtiq/shared-ui';
import { useMutation } from '@tanstack/react-query';
import { Button, Checkbox, Divider, Flex, Form, Input, Select, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';

import { AuthLayout } from '../components/AuthLayout';
import { FormError } from '../components/FormError';
import { applyServerErrors, parseForm, useMessage, zodRule } from '../forms';
import { auth, broadcast, startSession } from '../session';

const FIELDS = ['fullName', 'email', 'password', 'officeName', 'accountType', 'jurisdiction', 'defaultLanguage', 'currency', 'phone', 'acceptTerms', 'acceptPrivacy'];
const CURRENCIES = Intl.supportedValuesOf('currency');
const mayExist = (error: unknown): boolean => error instanceof ApiError && (error.status >= 500 || error.code === 'RES-002');
const shape = RegisterRequestSchema.shape;

/** Office signup (D-083): creates the office and its manager, then signs the manager in. */
export function SignupPage(): React.JSX.Element {
  const { t } = useTranslation();
  const message = useMessage();
  const { locale } = useLanguage();
  const currencyNames = useMemo(() => new Intl.DisplayNames(locale, { type: 'currency' }), [locale]);
  const navigate = useNavigate();
  const [form] = Form.useForm();

  const register = useMutation({
    // Never keep the password in the mutation cache after the page is gone.
    gcTime: 0,
    mutationFn: (body: RegisterRequest) => auth.register(body),
    onSuccess: (session) => {
      startSession(session);
      broadcast({ type: 'signedIn' });
      void navigate('/', { replace: true });
    },
    onError: (error) => applyServerErrors(form, error, FIELDS, message),
  });

  // The office language follows the AR | EN switch until the user picks one (D-090).
  useEffect(() => {
    if (!form.isFieldTouched('defaultLanguage')) form.setFieldValue('defaultLanguage', locale === 'en' ? 'EN' : 'AR');
  }, [form, locale]);

  const submit = (values: Record<string, unknown>) => {
    // Unticked boxes are `false`; the contract wants `true` and names the box in its message.
    const body = parseForm(RegisterRequestSchema, { ...values, phone: values['phone'] || undefined }, form, message);
    if (body) register.mutate(body);
  };

  return (
    <AuthLayout title={t('auth.signup.title')} subtitle={t('auth.signup.subtitle')}>
      <Flex vertical gap={16}>
        <FormError
          error={register.error}
          fields={FIELDS}
          testId="signup-error"
          action={
            // A 5xx after the office was created, or "already exists": the account may be there already (D-083).
            mayExist(register.error) ? (
              <Link to="/login" data-testid="signup-error-login">
                {t('auth.signup.maybeCreated')}
              </Link>
            ) : null
          }
        />
        <Form
          form={form}
          noValidate
          layout="vertical"
          requiredMark={false}
          onFinish={submit}
          disabled={register.isPending}
          initialValues={{
            jurisdiction: 'PALESTINE',
            defaultLanguage: locale === 'en' ? 'EN' : 'AR',
            currency: 'ILS',
            accountType: 'FIRM',
            acceptTerms: false,
            acceptPrivacy: false,
          }}
        >
          <Divider titlePlacement="start" plain>
            {t('auth.signup.account')}
          </Divider>
          <Form.Item name="fullName" label={t('auth.fields.fullName')} rules={zodRule(shape.fullName, message)}>
            <Input autoComplete="name" autoFocus data-testid="signup-full-name" />
          </Form.Item>
          <Form.Item name="email" label={t('auth.fields.email')} rules={zodRule(shape.email, message)}>
            <Input type="email" autoComplete="email" dir="ltr" data-testid="signup-email" />
          </Form.Item>
          <Form.Item name="password" label={t('auth.fields.password')} extra={t('auth.passwordHint')} rules={zodRule(shape.password, message)}>
            <Input.Password autoComplete="new-password" dir="ltr" data-testid="signup-password" />
          </Form.Item>
          <Form.Item name="phone" label={t('auth.fields.phone')} rules={zodRule(shape.phone, message)}>
            <Input type="tel" autoComplete="tel" dir="ltr" data-testid="signup-phone" />
          </Form.Item>

          <Divider titlePlacement="start" plain>
            {t('auth.signup.office')}
          </Divider>
          <Form.Item name="officeName" label={t('auth.fields.officeName')} rules={zodRule(shape.officeName, message)}>
            <Input autoComplete="organization" data-testid="signup-office-name" />
          </Form.Item>
          <Form.Item name="accountType" label={t('auth.fields.accountType')}>
            <Select data-testid="signup-account-type" options={ACCOUNT_TYPES.map((value) => ({ value, label: t(`enums.accountType.${value}`) }))} />
          </Form.Item>
          <Flex gap={16} wrap>
            <Form.Item name="jurisdiction" label={t('auth.fields.jurisdiction')} style={{ flex: '1 1 160px' }}>
              <Select
                showSearch={{ optionFilterProp: 'label' }}
                data-testid="signup-jurisdiction"
                options={JURISDICTIONS.map((value) => ({ value, label: t(`enums.jurisdiction.${value}`) }))}
              />
            </Form.Item>
            <Form.Item name="currency" label={t('auth.fields.currency')} style={{ flex: '1 1 120px' }}>
              <Select
                showSearch={{ optionFilterProp: 'title' }}
                data-testid="signup-currency"
                options={CURRENCIES.map((value) => {
                  const name = currencyNames.of(value) ?? value;
                  return { value, title: `${value} ${name}`, label: <><bdi>{value}</bdi> {name}</> };
                })}
              />
            </Form.Item>
          </Flex>
          <Form.Item name="defaultLanguage" label={t('auth.fields.defaultLanguage')}>
            <Select data-testid="signup-language" options={OFFICE_LANGUAGES.map((value) => ({ value, label: t(`enums.officeLanguage.${value}`) }))} />
          </Form.Item>

          <Form.Item name="acceptTerms" valuePropName="checked" rules={zodRule(shape.acceptTerms, message)} style={{ marginBlockEnd: 8 }}>
            <Checkbox data-testid="signup-accept-terms">
              {t('auth.signup.accept')}{' '}
              <Typography.Link href="/legal/terms" target="_blank" rel="noopener noreferrer">
                {t('auth.signup.terms')}
              </Typography.Link>
            </Checkbox>
          </Form.Item>
          <Form.Item name="acceptPrivacy" valuePropName="checked" rules={zodRule(shape.acceptPrivacy, message)}>
            <Checkbox data-testid="signup-accept-privacy">
              {t('auth.signup.accept')}{' '}
              <Typography.Link href="/legal/privacy" target="_blank" rel="noopener noreferrer">
                {t('auth.signup.privacy')}
              </Typography.Link>
            </Checkbox>
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={register.isPending} data-testid="signup-submit">
            {t('auth.signup.submit')}
          </Button>
        </Form>
        <Typography.Text type="secondary" style={{ textAlign: 'center' }}>
          {t('auth.signup.haveAccount')} <Link to="/login">{t('auth.signup.loginLink')}</Link>
        </Typography.Text>
      </Flex>
    </AuthLayout>
  );
}
