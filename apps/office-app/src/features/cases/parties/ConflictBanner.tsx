import { Alert, Button } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConflictsModal } from './ConflictsModal';
import { useOpenConflicts } from './use-parties';

/** Shown on the file page while a conflict of interest of the file is unresolved (W9, D-135). */
export function ConflictBanner({
  fileId,
  canResolve,
}: {
  readonly fileId: string;
  readonly canResolve: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const conflicts = useOpenConflicts(fileId);
  const items = conflicts.data?.items ?? [];
  // A failed load hides the banner: the Parties tab and the next add still show conflicts.
  if (items.length === 0) return null;
  return (
    <>
      <Alert
        type="warning"
        showIcon
        title={t('parties.conflicts.banner', {
          count: conflicts.data?.pagination.total ?? items.length,
        })}
        action={
          <Button size="small" onClick={() => setOpen(true)} data-testid="conflict-banner-review">
            {t('parties.conflicts.review')}
          </Button>
        }
        data-testid="conflict-banner"
      />
      <ConflictsModal
        open={open}
        fileId={fileId}
        conflicts={items}
        canResolve={canResolve}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
