import { NewPartySchema } from '@nexlegtiq/shared-contracts';
import { Form, Input, Segmented } from 'antd';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';

import { zodRule } from '../../auth/forms';

const field = NewPartySchema.shape;

/** The fields of a new registry party (D-135); identifiers and notes are stored encrypted (D-056). */
export function PartyFields(): React.JSX.Element {
  const { t } = useTranslation();
  const rule = (schema: z.ZodType) => zodRule(schema, (key) => t(key as never));
  const required = { required: true, message: t('validation.required') };
  const isIndividual = Form.useWatch<boolean | undefined>(['party', 'isIndividual']) ?? true;
  const encrypted = t('parties.form.encrypted');
  return (
    <>
      <Form.Item name={['party', 'isIndividual']} label={t('parties.form.kind')} initialValue>
        <Segmented<boolean>
          options={[
            { value: true, label: t('parties.row.person') },
            { value: false, label: t('parties.row.organisation') },
          ]}
          data-testid="party-kind"
        />
      </Form.Item>
      {isIndividual ? (
        <Form.Item
          name={['party', 'fullName']}
          label={t('parties.form.fullName')}
          rules={[required, ...rule(field.fullName)]}
        >
          <Input maxLength={200} data-testid="party-full-name" />
        </Form.Item>
      ) : (
        <Form.Item
          name={['party', 'companyName']}
          label={t('parties.form.companyName')}
          rules={[required, ...rule(field.companyName)]}
        >
          <Input maxLength={200} data-testid="party-company-name" />
        </Form.Item>
      )}
      <Form.Item
        name={['party', 'nationalId']}
        label={t('parties.form.nationalId')}
        extra={encrypted}
        rules={rule(field.nationalId)}
      >
        <Input dir="ltr" maxLength={50} data-testid="party-national-id" />
      </Form.Item>
      <Form.Item
        name={['party', 'taxId']}
        label={t('parties.form.taxId')}
        extra={encrypted}
        rules={rule(field.taxId)}
      >
        <Input dir="ltr" maxLength={50} data-testid="party-tax-id" />
      </Form.Item>
      <Form.Item
        name={['party', 'phone']}
        label={t('parties.form.phone')}
        rules={rule(field.phone)}
      >
        <Input dir="ltr" data-testid="party-phone" />
      </Form.Item>
      <Form.Item
        name={['party', 'email']}
        label={t('parties.form.email')}
        rules={rule(field.email)}
      >
        <Input dir="ltr" type="email" data-testid="party-email" />
      </Form.Item>
      <Form.Item
        name={['party', 'legalRepresentative']}
        label={t('parties.form.legalRepresentative')}
        rules={rule(field.legalRepresentative)}
      >
        <Input maxLength={200} data-testid="party-representative" />
      </Form.Item>
      <Form.Item
        name={['party', 'address']}
        label={t('parties.form.address')}
        rules={rule(field.address)}
      >
        <Input.TextArea rows={2} maxLength={500} data-testid="party-address" />
      </Form.Item>
      <Form.Item
        name={['party', 'notes']}
        label={t('parties.form.notes')}
        extra={encrypted}
        rules={rule(field.notes)}
      >
        <Input.TextArea rows={2} maxLength={2000} data-testid="party-notes" />
      </Form.Item>
    </>
  );
}
