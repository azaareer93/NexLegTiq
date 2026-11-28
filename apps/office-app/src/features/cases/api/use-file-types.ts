import { fileTypesApi } from '@nexlegtiq/shared-api-client';
import type { FileTypeOption } from '@nexlegtiq/shared-contracts';
import { useLanguage } from '@nexlegtiq/shared-ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { apiClient } from '../../auth';

const fileTypes = fileTypesApi(apiClient);

/** The active file types and sub-types of the office's country (D-261); platform data, so cached for a while. */
export const useFileTypes = () =>
  useQuery({
    queryKey: ['file-types'] as const,
    queryFn: ({ signal }) => fileTypes.list(signal),
    staleTime: 10 * 60_000,
  });

type Named = { readonly nameAr: string; readonly nameEn: string };

/** A reference row's name in the UI language. */
export function useLocalName(): (row: Named) => string {
  const { locale } = useLanguage();
  return (row) => (locale === 'en' ? row.nameEn : row.nameAr);
}

/**
 * The label of a type code: its name from the office's list, else the seeded label (`enums.fileType`), else the code
 * itself — a deactivated type is no longer in the list.
 */
export function useFileTypeLabel(types: readonly FileTypeOption[] | undefined) {
  const { t } = useTranslation();
  const name = useLocalName();
  return (code: string): string => {
    const type = types?.find((option) => option.code === code);
    return type ? name(type) : t(`enums.fileType.${code}`, { defaultValue: code });
  };
}
