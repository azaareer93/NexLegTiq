import {
  CreateFileSubTypeSchema,
  CreateFileTypeSchema,
  UpdateFileTypeSchema,
} from '@nexlegtiq/shared-contracts';
import type { AdminFileSubType, AdminFileType } from '@nexlegtiq/shared-contracts';
import type { Jurisdiction } from '@nexlegtiq/shared-types';
import { ApiErrorAlert, useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { App, Checkbox, Form, Input, InputNumber, Modal } from 'antd';
import { useTranslation } from 'react-i18next';

import { parseForm } from '../../auth/forms';
import { useFileTypeMutations } from '../hooks';

/** What the modal edits: a type of a country or a sub-type of a type; no `row` = create. */
export type FileTypeTarget =
  | { readonly kind: 'type'; readonly jurisdiction: Jurisdiction; readonly row?: AdminFileType }
  | { readonly kind: 'subType'; readonly typeId: string; readonly row?: AdminFileSubType };

interface Values {
  code?: string;
  numberCode?: string;
  nameAr?: string;
  nameEn?: string;
  sortOrder?: number | null;
  isActive?: boolean;
}

const FIELDS = ['code', 'numberCode', 'nameAr', 'nameEn', 'sortOrder', 'isActive'];
const EDITABLE = ['nameAr', 'nameEn', 'sortOrder', 'isActive'] as const;

/** Only the fields the admin changed: a save never audits a no-op. */
function changed(values: Values, row: AdminFileType | AdminFileSubType) {
  return Object.fromEntries(
    EDITABLE.filter((key) => values[key] !== row[key]).map((key) => [key, values[key]]),
  );
}

/**
 * Create or edit a file type or sub-type (D-261). The code and number code are set once, at creation; order and the
 * active flag are edited here (a deactivated one stays on the files that have it).
 */
export function FileTypeModal({
  target,
  onClose,
}: {
  readonly target: FileTypeTarget;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { translateKey, applyToForm } = useApiErrorHandler();
  const [form] = Form.useForm<Values>();
  const mutations = useFileTypeMutations();
  const isType = target.kind === 'type';
  const isNew = !target.row;
  const pending = Object.values(mutations).some((mutation) => mutation.isPending);
  const failed = Object.values(mutations).find((mutation) => mutation.isError)?.error;

  const save = async (values: Values): Promise<void> => {
    if (target.row) {
      const changes = changed(values, target.row);
      if (Object.keys(changes).length === 0) return onClose();
      const body = parseForm(UpdateFileTypeSchema, changes, form, translateKey);
      if (!body) return;
      const args = { id: target.row.id, body };
      await (isType ? mutations.update : mutations.updateSubType).mutateAsync(args);
    } else if (target.kind === 'type') {
      const body = parseForm(
        CreateFileTypeSchema,
        { ...values, jurisdiction: target.jurisdiction },
        form,
        translateKey,
      );
      if (!body) return;
      await mutations.create.mutateAsync(body);
    } else {
      const body = parseForm(CreateFileSubTypeSchema, values, form, translateKey);
      if (!body) return;
      await mutations.createSubType.mutateAsync({ typeId: target.typeId, body });
    }
    void message.success(t('admin.fileTypes.saved'));
    onClose();
  };

  const submit = async (): Promise<void> => {
    const values = form.getFieldsValue(true) as Values;
    try {
      await save({ ...values, sortOrder: values.sortOrder ?? 0 });
    } catch (error) {
      applyToForm(form, error, FIELDS);
    }
  };

  const title = `admin.fileTypes.modal.${isNew ? 'new' : 'edit'}${isType ? 'Type' : 'SubType'}`;
  return (
    <Modal
      open
      title={t(title as 'admin.fileTypes.modal.newType')}
      okText={t('common.actions.save')}
      cancelText={t('common.actions.cancel')}
      okButtonProps={{ 'data-testid': 'file-type-confirm' }}
      confirmLoading={pending}
      onOk={() => void submit()}
      onCancel={onClose}
    >
      <Form
        form={form}
        layout="vertical"
        noValidate
        initialValues={{ sortOrder: 0, isActive: true, ...target.row }}
      >
        {isType ? (
          <>
            <Form.Item
              name="code"
              label={t('admin.fileTypes.fields.code')}
              extra={isNew ? t('admin.fileTypes.fields.codeHelp') : undefined}
            >
              <Input dir="ltr" disabled={!isNew} data-testid="file-type-code" />
            </Form.Item>
            <Form.Item
              name="numberCode"
              label={t('admin.fileTypes.fields.numberCode')}
              extra={isNew ? t('admin.fileTypes.fields.numberCodeHelp') : undefined}
            >
              <Input dir="ltr" maxLength={6} disabled={!isNew} data-testid="file-type-number" />
            </Form.Item>
          </>
        ) : null}
        <Form.Item name="nameAr" label={t('admin.fileTypes.fields.nameAr')}>
          <Input dir="rtl" lang="ar" maxLength={100} data-testid="file-type-name-ar" />
        </Form.Item>
        <Form.Item name="nameEn" label={t('admin.fileTypes.fields.nameEn')}>
          <Input dir="ltr" lang="en" maxLength={100} data-testid="file-type-name-en" />
        </Form.Item>
        <Form.Item name="sortOrder" label={t('admin.fileTypes.fields.sortOrder')}>
          <InputNumber dir="ltr" style={{ inlineSize: '100%' }} min={0} max={10_000} />
        </Form.Item>
        <Form.Item name="isActive" valuePropName="checked">
          <Checkbox data-testid="file-type-active">{t('admin.fileTypes.fields.isActive')}</Checkbox>
        </Form.Item>
      </Form>
      {failed ? <ApiErrorAlert error={failed} fields={FIELDS} /> : null}
    </Modal>
  );
}
