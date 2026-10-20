import { ApiError } from '@nexlegtiq/shared-api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

import { startRealtime } from './realtime';
import { useInvalidateOn, useRealtime } from './use-realtime';
import { sockets } from '../../test/fake-socket';
import type { FakeSocket } from '../../test/fake-socket';
import { auth, resetSession, useSession } from '../auth/session';

const ID = '01900000-0000-7000-8000-0000000000a1';
const FILE = '01900000-0000-7000-8000-0000000000f1';

const latest = (): FakeSocket => sockets[sockets.length - 1] as FakeSocket;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('realtime client (D-129)', () => {
  let stop: () => void;

  beforeEach(() => {
    sockets.length = 0;
    resetSession();
    stop = startRealtime();
  });

  afterEach(() => {
    stop();
    vi.restoreAllMocks();
  });

  it('should open a socket per access token and close it on sign-out', () => {
    expect(sockets).toHaveLength(0);
    useSession.setState({ accessToken: 'one' });
    expect(latest().url).toMatch(/\/ws$/);
    expect(latest().options.auth).toEqual({ token: 'one' });

    // A refreshed token re-authenticates: the old socket closes, a new one carries the new token.
    useSession.setState({ accessToken: 'two' });
    expect(sockets[0]?.disconnected).toBe(true);
    expect(latest().options.auth).toEqual({ token: 'two' });

    useSession.setState({ idleMinutes: 45 });
    expect(sockets).toHaveLength(2);

    useSession.setState({ accessToken: null });
    expect(latest().disconnected).toBe(true);
  });

  it('should hand contract-valid events to listeners and drop anything else', () => {
    useSession.setState({ accessToken: 'one' });
    const handler = vi.fn();
    renderHook(() => useRealtime('notification', handler));

    latest().push('notification', { notificationId: ID });
    latest().push('notification', { notificationId: 'not-a-uuid' });
    latest().push('task.updated', { taskId: ID, fileId: null });
    latest().push('unknown.event', { notificationId: ID });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ notificationId: ID });
  });

  it('should stop listening on unmount and always call the latest handler', () => {
    useSession.setState({ accessToken: 'one' });
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(({ fn }) => useRealtime('notification', fn), {
      initialProps: { fn: first },
    });
    rerender({ fn: second });
    latest().push('notification', { notificationId: ID });
    unmount();
    latest().push('notification', { notificationId: ID });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('should invalidate the queries an event makes stale', () => {
    useSession.setState({ accessToken: 'one' });
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(
      () => useInvalidateOn('session.scheduled', ({ fileId }) => [['cases', 'detail', fileId]]),
      { wrapper },
    );
    latest().push('session.scheduled', { sessionId: ID, fileId: FILE });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['cases', 'detail', FILE] });
  });

  it('should renew the token when the server refuses it as expired or ends the socket at expiry', async () => {
    let fail = (): void => undefined;
    const refresh = vi
      .spyOn(auth, 'refresh')
      .mockImplementation(
        () => new Promise((_, reject) => (fail = () => reject(new Error('offline')))),
      );
    useSession.setState({ accessToken: 'one' });

    latest().fire(
      'connect_error',
      Object.assign(new Error('AUTH-003'), { data: { code: 'AUTH-003' } }),
    );
    latest().fire('disconnect', 'transport close');
    expect(refresh).not.toHaveBeenCalled();

    latest().fire(
      'connect_error',
      Object.assign(new Error('AUTH-002'), { data: { code: 'AUTH-002' } }),
    );
    latest().fire('disconnect', 'io server disconnect');
    // One renewal at a time.
    expect(refresh).toHaveBeenCalledTimes(1);
    fail();
    await flush();
  });

  it('should end the session when the renewal is refused, and keep it when offline', async () => {
    const refresh = vi
      .spyOn(auth, 'refresh')
      .mockRejectedValueOnce(new ApiError('SYS-002', 'offline', 0))
      .mockRejectedValueOnce(new ApiError('AUTH-004', 'gone', 401));
    useSession.setState({ status: 'authenticated', accessToken: 'one' });

    latest().fire('disconnect', 'io server disconnect');
    await flush();
    expect(useSession.getState().status).toBe('authenticated');

    latest().fire('disconnect', 'io server disconnect');
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(useSession.getState()).toMatchObject({ status: 'anonymous', signOutReason: 'expired' });
  });
});
