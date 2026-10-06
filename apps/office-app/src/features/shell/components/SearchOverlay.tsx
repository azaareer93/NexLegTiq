import { SearchOutlined } from '@ant-design/icons';
import { EmptyState } from '@nexlegtiq/shared-ui';
import { Button, Input, Modal } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The global search entry (header button and Ctrl/Cmd+K). A placeholder until the search story (MVP-82) fills it.
 * `KeyK` is the physical key, so the shortcut works on an Arabic keyboard layout too.
 */
export function SearchOverlay({ compact = false }: { readonly compact?: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyK') {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <Button icon={<SearchOutlined />} onClick={() => setOpen(true)} aria-label={t('shell.search.open')} data-testid="search-open">
        {compact ? null : (
          <>
            {t('shell.search.open')} <kbd dir="ltr">{t('shell.search.shortcut')}</kbd>
          </>
        )}
      </Button>
      <Modal open={open} onCancel={() => setOpen(false)} footer={null} title={t('shell.search.open')} destroyOnHidden data-testid="search-overlay">
        <Input autoFocus prefix={<SearchOutlined />} placeholder={t('shell.search.placeholder')} aria-label={t('shell.search.open')} data-testid="search-input" />
        <EmptyState description={t('shell.search.comingSoon')} />
      </Modal>
    </>
  );
}
