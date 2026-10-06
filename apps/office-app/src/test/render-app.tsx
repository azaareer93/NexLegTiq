import type { AuthUser } from '@nexlegtiq/shared-contracts';
import { permissionsFor } from '@nexlegtiq/shared-types';
import type { Locale } from '@nexlegtiq/shared-types';
import { LANGUAGE_STORAGE_KEY } from '@nexlegtiq/shared-ui';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';

import { AppRoot } from '../app/app-root';
import { routes } from '../app/routes';
import { API_URL, resetSession, useSession } from '../features/auth/session';

export const api = (path: string) => `${API_URL}/api/v1/${path}`;
const meta = { timestamp: '2026-10-05T10:00:00.000Z', requestId: 'req-12345678' };
export const ok = (data: JsonBodyType = null, status = 200) => HttpResponse.json({ success: true, data, meta }, { status });
export const fail = (status: number, code: string, details?: { field: string; message: string }[]) =>
  HttpResponse.json({ success: false, error: { code, message: `dev ${code}`, details }, meta }, { status });

export const USER: AuthUser = {
  id: '01920000-0000-7000-8000-000000000001',
  fullName: 'Layla Haddad',
  email: 'layla@example.test',
  role: 'OFFICE_MANAGER',
  officeId: '01920000-0000-7000-8000-000000000002',
  officeName: 'Haddad Law',
  uiLanguage: 'EN',
  permissions: [...permissionsFor('OFFICE_MANAGER')],
  emailVerified: true,
  verifyBy: null,
};
export const SESSION = { accessToken: 'access-1', expiresIn: 900, user: USER };

export const server = setupServer();

/** MSW + a fresh session per test. Call once at the top of a spec file. */
export function setupTestServer(): void {
  beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
  afterEach(() => {
    cleanup();
    server.resetHandlers();
    resetSession();
    localStorage.clear();
    vi.useRealTimers();
  });
  afterAll(() => server.close());
}

export function signedIn(user: Partial<AuthUser> = {}): void {
  useSession.setState({ status: 'authenticated', user: { ...USER, ...user }, accessToken: 'access-1' });
}

export function signedOut(): void {
  useSession.setState({ status: 'anonymous', user: null, accessToken: null });
}

/** The whole app (providers + routes) at `path`, in `locale` for a signed-out visitor; `strict` as in `main.tsx`. */
export function renderApp(path: string, locale: Locale = 'en', { strict = false } = {}): { router: ReturnType<typeof createMemoryRouter> } {
  localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const app = (
    <AppRoot>
      <RouterProvider router={router} />
    </AppRoot>
  );
  render(strict ? <StrictMode>{app}</StrictMode> : app);
  return { router };
}

/** The window width the next render sees (AntD breakpoints read it through the `matchMedia` stub in setup.ts). */
export function setViewport(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

export { resizeTo } from './media';

/** Opens the account menu and signs out (the shell's menu holds sign-out). */
export async function signOutFromMenu(): Promise<void> {
  fireEvent.click(await screen.findByTestId('profile-menu'));
  fireEvent.click(await screen.findByText(/^(Sign out|تسجيل الخروج)$/));
}

/** Messages this tab sends to the other tabs (collected on a second channel, as another tab would see them). */
export function listenToOtherTabs(): { messages: unknown[]; close: () => void } {
  const channel = new BroadcastChannel('nlq-session');
  const messages: unknown[] = [];
  channel.onmessage = ({ data }: MessageEvent<unknown>) => messages.push(data);
  return { messages, close: () => channel.close() };
}

export { http };
