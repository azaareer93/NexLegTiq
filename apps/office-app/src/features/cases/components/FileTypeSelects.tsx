import type { FileSubType } from '@nexlegtiq/shared-contracts';
import { Select } from 'antd';
import type { SelectProps } from 'antd';
import { useTranslation } from 'react-i18next';

import { useFileTypes, useLocalName } from '../api/use-file-types';

type Props = Omit<SelectProps<string>, 'options' | 'loading'>;

/** The active file types of the office's country, in the platform's order (D-261). */
export function FileTypeSelect(props: Props): React.JSX.Element {
  const types = useFileTypes();
  const name = useLocalName();
  return (
    <Select
      showSearch={{ optionFilterProp: 'label' }}
      loading={types.isLoading}
      options={(types.data ?? []).map((type) => ({ value: type.code, label: name(type) }))}
      {...props}
    />
  );
}

/**
 * The active sub-types of `typeCode`. `current` (the file's sub-type) stays offered after it was deactivated, so an edit
 * never drops it silently. Disabled while the type has none.
 */
export function SubTypeSelect({
  typeCode,
  current,
  ...props
}: Props & {
  readonly typeCode: string | undefined;
  readonly current?: FileSubType | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const types = useFileTypes();
  const name = useLocalName();
  const subTypes = types.data?.find((type) => type.code === typeCode)?.subTypes ?? [];
  const options = [
    ...(current && !subTypes.some((sub) => sub.id === current.id) ? [current] : []),
    ...subTypes,
  ].map((sub) => ({ value: sub.id, label: name(sub) }));
  return (
    <Select
      allowClear
      showSearch={{ optionFilterProp: 'label' }}
      loading={types.isLoading}
      disabled={options.length === 0}
      placeholder={options.length === 0 ? t('cases.file.noSubTypes') : undefined}
      options={options}
      {...props}
    />
  );
}
