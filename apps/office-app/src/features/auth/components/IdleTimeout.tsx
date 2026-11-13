import { notificationsApi } from '@nexlegtiq/shared-api-client';
import { Button, Modal } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  apiClient,
  broadcast,
  onRemoteActivity,
  recordActivity,
  signOut,
  useSession,
} from '../session';

/** The warning shows during the last minute (MVP-42). */
export const IDLE_WARNING_MS = 60_000;
/** Activity is shared with the other tabs at most this often, so working in one tab keeps them all signed in. */
const BROADCAST_EVERY_MS = 15_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'mousemove'] as const;
/**
 * The server counts only API requests as activity (MVP-168): while the user works without any (reading a long document),
 * a light authenticated request at most this often keeps the server's idle timer in step with this one.
 */
const HEARTBEAT_EVERY_MS = 60_000;
const notifications = notificationsApi(apiClient);

/**
 * Signs the user out after the office's idle timeout (D-053, default 30 min) with a one-minute warning. Counted from the
 * last activity in any tab of this browser; timestamps, not timers, decide, so a sleeping laptop is judged correctly.
 */
export function IdleTimeout(): React.JSX.Element | null {
  const { t } = useTranslation();
  const idleMs = useSession((state) => state.idleMinutes) * 60_000;
  const lastActivity = useRef(Date.now());
  const lastBroadcast = useRef(0);
  const lastHeartbeat = useRef(Date.now());
  const warning = useRef(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    const touch = (at = Date.now()) => {
      lastActivity.current = Math.max(lastActivity.current, at);
    };
    const onLocalActivity = () => {
      // While the warning is open only its buttons count: moving towards "Sign out" must not close it.
      if (warning.current) return;
      const now = Date.now();
      touch(now);
      if (now - lastBroadcast.current >= BROADCAST_EVERY_MS) {
        lastBroadcast.current = now;
        broadcast({ type: 'activity', at: now });
        recordActivity(now);
      }
      if (now - lastHeartbeat.current >= HEARTBEAT_EVERY_MS) {
        lastHeartbeat.current = now;
        // Its answer does not matter; a failure is the next request's to report.
        notifications.unreadCount().catch(() => undefined);
      }
    };
    ACTIVITY_EVENTS.forEach((event) =>
      window.addEventListener(event, onLocalActivity, { passive: true }),
    );
    const stopRemote = onRemoteActivity(touch);

    const tick = window.setInterval(() => {
      if (useSession.getState().status !== 'authenticated') return;
      const left = idleMs - (Date.now() - lastActivity.current);
      if (left <= 0) {
        window.clearInterval(tick);
        void signOut('idle');
      } else {
        warning.current = left <= IDLE_WARNING_MS;
        setSecondsLeft(warning.current ? Math.ceil(left / 1000) : null);
      }
    }, 1000);

    return () => {
      ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, onLocalActivity));
      stopRemote();
      window.clearInterval(tick);
    };
  }, [idleMs]);

  const stay = () => {
    lastActivity.current = Date.now();
    warning.current = false;
    broadcast({ type: 'activity', at: lastActivity.current });
    recordActivity(lastActivity.current);
    lastHeartbeat.current = lastActivity.current;
    notifications.unreadCount().catch(() => undefined);
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
      {/* Read once when the dialog opens; a live region would re-announce every second. */}
      <p data-testid="idle-countdown">{t('auth.idle.countdown', { count: secondsLeft ?? 0 })}</p>
    </Modal>
  );
}
