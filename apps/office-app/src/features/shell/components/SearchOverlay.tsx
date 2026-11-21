import { SearchOutlined } from '@ant-design/icons';
import { Button, Flex, Modal, theme } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SearchPanel } from '../../search';
import { ariaKeys, comboLabel } from '../shortcuts';

const COMBO = { mod: 'Mod', key: 'K' } as const;

/**
 * Ctrl+K (⌘K on a Mac) and nothing else: not with Shift or Alt (AltGr is Ctrl+Alt on Windows layouts, used to type
 * characters), not on auto-repeat or while an input method is composing. `KeyK` is the physical key, so it works on an
 * Arabic layout too.
 */
export const isSearchShortcut = (event: KeyboardEvent): boolean =>
  (event.ctrlKey || event.metaKey) &&
  !event.shiftKey &&
  !event.altKey &&
  !event.repeat &&
  !event.isComposing &&
  event.code === 'KeyK';

/** The global search entry (header button and shortcut); the overlay is the search feature's panel (D-172). */
export function SearchOverlay({
  compact = false,
}: {
  readonly compact?: boolean;
}): React.JSX.Element {
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
        aria-keyshortcuts={ariaKeys(COMBO)}
        data-testid="search-open"
      >
        {compact ? null : (
          <Flex component="span" align="center" gap={token.marginXS}>
            <span>{t('shell.search.open')}</span>
            <kbd dir="ltr" style={{ fontFamily: 'inherit', color: token.colorTextSecondary }}>
              {comboLabel(COMBO)}
            </kbd>
          </Flex>
        )}
      </Button>
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        title={t('shell.search.open')}
        destroyOnHidden
        width={640}
      >
        <SearchPanel onClose={() => setOpen(false)} />
      </Modal>
    </>
  );
}
