import { isErrorCode } from '@nexlegtiq/shared-types';
import { ErrorState, isApiError, useApiErrorHandler } from '@nexlegtiq/shared-ui';

/** A list that failed to load: its error code, a support reference and a retry. */
export function ListError({
  error,
  onRetry,
  testId,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly testId: string;
}): React.JSX.Element {
  const { referenceOf } = useApiErrorHandler();
  const code = isApiError(error) ? error.code : undefined;
  return (
    <div data-testid={testId}>
      <ErrorState
        code={code !== undefined && isErrorCode(code) ? code : undefined}
        requestId={referenceOf(error)}
        onRetry={onRetry}
      />
    </div>
  );
}
