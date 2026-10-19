import { CreateCaseSchema } from '@nexlegtiq/shared-contracts';
import { BILLING_METHODS } from '@nexlegtiq/shared-types';
import { useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Form, Input, Select } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { zodRule } from '../../auth/forms';
import { useDebounced } from '../../clients/list-params';
import { useCourts, useDirectory, useJudges } from '../api/use-cases';
import { lawyersOf, paralegalsOf } from '../case-form';
import type { CreateField } from '../case-form';

const useRules = () => {
  const { translateKey } = useApiErrorHandler();
  return (field: Exclude<CreateField, 'clientId'>) =>
    zodRule(CreateCaseSchema.shape[field], translateKey);
};

/** Responsible lawyer (who the API accepts: OM, SL, L) and an optional paralegal, from the office directory (D-123). */
export function PeopleFields(): React.JSX.Element {
  const { t } = useTranslation();
  const rules = useRules();
  const directory = useDirectory();
  const people = directory.data ?? [];
  const option = (person: { id: string; fullName: string; role: string }) => ({
    value: person.id,
    label: isolate(person.fullName),
  });
  return (
    <>
      <Form.Item
        name="responsibleLawyerId"
        label={t('cases.create.lawyer')}
        rules={rules('responsibleLawyerId')}
      >
        <Select
          showSearch={{ optionFilterProp: 'label' }}
          loading={directory.isPending}
          options={lawyersOf(people).map(option)}
          data-testid="create-lawyer"
        />
      </Form.Item>
      <Form.Item name="responsibleParalegalId" label={t('cases.create.paralegal')}>
        <Select
          allowClear
          showSearch={{ optionFilterProp: 'label' }}
          placeholder={t('cases.create.noParalegal')}
          loading={directory.isPending}
          options={paralegalsOf(people).map(option)}
          data-testid="create-paralegal"
        />
      </Form.Item>
    </>
  );
}

/** An optional court (server search, platform and office courts) and a judge of that court. */
export function CourtFields(): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const form = Form.useFormInstance();
  const courtId = Form.useWatch<string | undefined>('courtId', form);
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  // The picked court keeps its name when a later search no longer lists it (as ClientSelect does).
  const [picked, setPicked] = useState<{ value: string; label: string } | undefined>();
  const search = useDebounced(text.trim());
  const courts = useCourts(search, open || courtId !== undefined);
  const judges = useJudges(courtId);
  const arabic = i18n.language === 'ar';
  const options = (courts.data?.items ?? []).map((court) => ({
    value: court.id,
    label: isolate(arabic ? court.nameAr : (court.nameEn ?? court.nameAr)),
  }));
  if (picked && picked.value === courtId && !options.some((o) => o.value === picked.value)) {
    options.unshift(picked);
  }
  return (
    <>
      <Form.Item name="courtId" label={t('cases.create.court')}>
        <Select
          allowClear
          showSearch={{ filterOption: false, searchValue: text, onSearch: setText }}
          onOpenChange={setOpen}
          onChange={(value?: string) => {
            setPicked(options.find((option) => option.value === value));
            form.setFieldValue('judgeId', undefined);
          }}
          placeholder={t('cases.create.courtPlaceholder')}
          loading={courts.isFetching}
          options={options}
          data-testid="create-court"
        />
      </Form.Item>
      <Form.Item name="judgeId" label={t('cases.create.judge')}>
        <Select
          allowClear
          disabled={courtId === undefined}
          placeholder={courtId === undefined ? t('cases.create.judgePickCourt') : undefined}
          loading={judges.isFetching}
          options={(judges.data ?? [])
            .filter((judge) => judge.isActive)
            .map((judge) => ({ value: judge.id, label: isolate(judge.fullName) }))}
          data-testid="create-judge"
        />
      </Form.Item>
    </>
  );
}

/** Billing terms, only for who may set them (`generate:invoice`, D-096); left empty, the office's defaults apply. */
export function BillingFields(): React.JSX.Element {
  const { t } = useTranslation();
  const rules = useRules();
  const method = Form.useWatch<string | undefined>('billingMethod');
  return (
    <>
      <Form.Item name="billingMethod" label={t('cases.file.billing.method')}>
        <Select
          allowClear
          placeholder={t('cases.create.billingDefault')}
          options={BILLING_METHODS.map((value) => ({
            value,
            label: t(`enums.billingMethod.${value}`),
          }))}
          data-testid="create-billing"
        />
      </Form.Item>
      {method === 'HOURLY' ? (
        <Form.Item
          name="hourlyRate"
          label={t('cases.file.billing.rate')}
          rules={rules('hourlyRate')}
        >
          <Input
            dir="ltr"
            inputMode="decimal"
            placeholder={t('cases.create.billingDefault')}
            data-testid="create-rate"
          />
        </Form.Item>
      ) : null}
      {method === 'FIXED_FEE' ? (
        <Form.Item name="fixedFee" label={t('cases.file.billing.fee')} rules={rules('fixedFee')}>
          <Input dir="ltr" inputMode="decimal" data-testid="create-fee" />
        </Form.Item>
      ) : null}
    </>
  );
}
