import { isErrorCode } from '@nexlegtiq/shared-types';
import { ErrorState } from '@nexlegtiq/shared-ui';

/** A failed load of the drawer, explained by its error code with a retry (D-093). */
export function QueryError({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}): React.JSX.Element {
  const { code, requestId } = (error ?? {}) as { code?: string; requestId?: string };
  return (
    <ErrorState
      code={code && isErrorCode(code) ? code : undefined}
      requestId={requestId}
      onRetry={onRetry}
    />
  );
}
