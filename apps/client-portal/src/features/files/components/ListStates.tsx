import { ApiError } from '@nexlegtiq/shared-api-client';
import { isErrorCode } from '@nexlegtiq/shared-types';
import { ErrorState, useApiErrorHandler, useFormat } from '@nexlegtiq/shared-ui';
import { useTranslation } from 'react-i18next';

/** A failed load, shown with its code and support reference, with a retry. */
export function LoadFailed({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}): React.JSX.Element {
  const { referenceOf } = useApiErrorHandler();
  const apiError = error instanceof ApiError ? error : null;
  return (
    <ErrorState
      code={apiError && isErrorCode(apiError.code) ? apiError.code : undefined}
      requestId={referenceOf(error)}
      onRetry={onRetry}
    />
  );
}

/** File sizes (bytes as text, BigInt on the server) in the reader's language: B, KB or MB with one decimal. */
export function useSize(): (bytes: string) => string {
  const { t } = useTranslation();
  const format = useFormat();
  return (text) => {
    const bytes = Number(text);
    if (bytes < 1024) return t('documents.size.bytes', { value: format.number(bytes) });
    if (bytes < 1024 * 1024) {
      return t('documents.size.kb', { value: format.number(Math.round(bytes / 102.4) / 10) });
    }
    return t('documents.size.mb', { value: format.number(Math.round(bytes / 104_857.6) / 10) });
  };
}
