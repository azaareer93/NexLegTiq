import { ApiErrorAlert } from '@nexlegtiq/shared-ui';
import { useTranslation } from 'react-i18next';

import { AuditTable } from './AuditTable';
import { useFileAudit } from '../api/use-audit';

/** The file's Audit tab (D-180, `view:audit`): who did what on this file, newest first. */
export function FileAuditTab({ fileId }: { readonly fileId: string }) {
  const { t } = useTranslation();
  const audit = useFileAudit(fileId);
  return (
    <section data-testid="file-audit" aria-label={t('audit.fileTitle')}>
      {audit.isError ? <ApiErrorAlert error={audit.error} /> : null}
      <AuditTable
        entries={audit.data?.pages.flatMap((p) => p.items) ?? []}
        loading={audit.isPending}
        hasMore={audit.hasNextPage}
        loadingMore={audit.isFetchingNextPage}
        onMore={() => void audit.fetchNextPage()}
      />
    </section>
  );
}
