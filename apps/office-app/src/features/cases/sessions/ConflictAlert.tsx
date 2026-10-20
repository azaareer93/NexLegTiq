import { Ltr, useFormat } from '@nexlegtiq/shared-ui';
import { Alert, Button, Flex } from 'antd';
import { useTranslation } from 'react-i18next';

import type { Conflict } from './session-form';

/**
 * 409 BIZ-004 (D-116): the attending lawyer's overlapping hearings — their time, and the file number only when the user
 * may open that file — with "schedule anyway", which sends the same request acknowledging the conflict.
 */
export function ConflictAlert({
  conflicts,
  onConfirm,
}: {
  readonly conflicts: readonly Conflict[];
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <Alert
      type="warning"
      showIcon
      title={t('sessions.conflict.title')}
      description={
        <Flex vertical gap={4}>
          <ul style={{ margin: 0, paddingInlineStart: 20 }}>
            {conflicts.map((conflict) => (
              <li key={`${conflict.sessionId ?? 'hidden'}-${conflict.startsAt}`}>
                {format.dateTime(conflict.startsAt)}
                {' · '}
                {conflict.fileNumber ? (
                  <Ltr>{conflict.fileNumber}</Ltr>
                ) : (
                  t('sessions.conflict.hidden')
                )}
              </li>
            ))}
          </ul>
          <span>
            <Button size="small" onClick={onConfirm} data-testid="session-conflict-anyway">
              {t('sessions.conflict.anyway')}
            </Button>
          </span>
        </Flex>
      }
      data-testid="session-conflict"
    />
  );
}
