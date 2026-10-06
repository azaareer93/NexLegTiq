import { SearchOutlined } from '@ant-design/icons';
import { EmptyState } from '@nexlegtiq/shared-ui';
import { Button, Flex, Input, Modal, theme } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** The shortcut as the platform writes it; key names are not translated. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT = IS_MAC ? '⌘ K' : 'Ctrl K';

/**
 * Ctrl+K (⌘K on a Mac) and nothing else: not with Shift or Alt (AltGr is Ctrl+Alt on Windows layouts, used to type
 * characters), not on auto-repeat or while an input method is composing. `KeyK` is the physical key, so it works on an
 * Arabic layout too.
 */
export const isSearchShortcut = (event: KeyboardEvent): boolean =>
  (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && !event.repeat && !event.isComposing && event.code === 'KeyK';

/** The global search entry (header button and shortcut). A placeholder until the search feature fills it. */
export function SearchOverlay({ compact = false }: { readonly compact?: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isSearchShortcut(event)) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <Button
        icon={<SearchOutlined />}
        onClick={() => setOpen(true)}
        aria-label={t('shell.search.open')}
        aria-keyshortcuts="Control+K Meta+K"
        data-testid="search-open"
      >
        {compact ? null : (
          <Flex component="span" align="center" gap={token.marginXS}>
            <span>{t('shell.search.open')}</span>
            <kbd dir="ltr" style={{ fontFamily: 'inherit', color: token.colorTextSecondary }}>
              {SHORTCUT}
            </kbd>
          </Flex>
        )}
      </Button>
      <Modal open={open} onCancel={() => setOpen(false)} footer={null} title={t('shell.search.open')} destroyOnHidden>
        <Input autoFocus prefix={<SearchOutlined />} placeholder={t('shell.search.placeholder')} aria-label={t('shell.search.open')} data-testid="search-input" />
        <EmptyState description={t('shell.search.comingSoon')} />
      </Modal>
    </>
  );
}
