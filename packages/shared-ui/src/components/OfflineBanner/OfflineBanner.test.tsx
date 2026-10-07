import type { Locale } from '@nexlegtiq/shared-types';
import { act, cleanup, render, screen } from '@testing-library/react';

import { NexProvider } from '../NexProvider';
import { OfflineBanner } from './OfflineBanner';

const goOffline = () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  act(() => void window.dispatchEvent(new Event('offline')));
};
const goOnline = () => {
  vi.restoreAllMocks();
  act(() => void window.dispatchEvent(new Event('online')));
};

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const renderIn = (locale: Locale) =>
  render(<OfflineBanner />, {
    wrapper: ({ children }) => <NexProvider userLocale={locale}>{children}</NexProvider>,
  });

describe('OfflineBanner', () => {
  it.each([
    ['en', 'You are offline'],
    ['ar', 'لا يوجد اتصال بالإنترنت'],
  ] as const)(
    'should appear while offline and go when the connection is back (%s)',
    (locale, text) => {
      renderIn(locale);
      expect(screen.queryByTestId('offline-banner')).toBeNull();
      goOffline();
      expect(screen.getByTestId('offline-banner').textContent).toContain(text);
      goOnline();
      expect(screen.queryByTestId('offline-banner')).toBeNull();
    },
  );
});
