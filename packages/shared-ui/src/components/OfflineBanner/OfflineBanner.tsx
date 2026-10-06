import { Alert } from 'antd';
import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

const subscribe = (onChange: () => void) => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
};

/** The browser's own connection state (`navigator.onLine`): "offline" is reliable, "online" only means a network exists. */
export const useOnline = (): boolean => useSyncExternalStore(subscribe, () => navigator.onLine, () => true);

/** Shown while the browser is offline, so a failed save is not a surprise; disappears when the connection is back (D-093). */
export function OfflineBanner(): React.JSX.Element | null {
  const { t } = useTranslation();
  return useOnline() ? null : <Alert type="warning" banner showIcon role="status" title={t('common.states.offline')} data-testid="offline-banner" />;
}
