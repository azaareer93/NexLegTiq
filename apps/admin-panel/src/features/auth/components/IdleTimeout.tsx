import { Button, Modal } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IDLE_MINUTES, signOut } from '../session';

/** The warning shows during the last minute. */
export const IDLE_WARNING_MS = 60_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;

/**
 * Signs the admin out after 30 minutes without activity in this tab, with a one-minute warning (D-053). Timestamps, not
 * timers, decide, so a sleeping laptop is judged correctly. Unlike the office app there is no cross-tab activity: the
 * founder works in one tab, and the server ends the session 30 minutes after the last refresh anyway (D-145).
 */
export function IdleTimeout(): React.JSX.Element {
  const { t } = useTranslation();
  const lastActivity = useRef(Date.now());
  const warning = useRef(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    const onActivity = () => {
      // While the warning is open only its buttons count.
      if (!warning.current) lastActivity.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((event) =>
      window.addEventListener(event, onActivity, { passive: true }),
    );
    const tick = window.setInterval(() => {
      const left = IDLE_MINUTES * 60_000 - (Date.now() - lastActivity.current);
      if (left <= 0) {
        window.clearInterval(tick);
        void signOut('idle');
      } else {
        warning.current = left <= IDLE_WARNING_MS;
        setSecondsLeft(warning.current ? Math.ceil(left / 1000) : null);
      }
    }, 1000);
    return () => {
      ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, onActivity));
      window.clearInterval(tick);
    };
  }, []);

  const stay = () => {
    lastActivity.current = Date.now();
    warning.current = false;
    setSecondsLeft(null);
  };

  return (
    <Modal
      open={secondsLeft !== null}
      title={t('auth.idle.title')}
      closable={false}
      mask={{ closable: false }}
      keyboard={false}
      footer={[
        <Button key="out" data-testid="idle-sign-out" onClick={() => void signOut('signedOut')}>
          {t('auth.idle.signOut')}
        </Button>,
        <Button key="stay" type="primary" data-testid="idle-stay" onClick={stay} autoFocus>
          {t('auth.idle.stay')}
        </Button>,
      ]}
    >
      <p data-testid="idle-countdown">{t('auth.idle.countdown', { count: secondsLeft ?? 0 })}</p>
    </Modal>
  );
}
