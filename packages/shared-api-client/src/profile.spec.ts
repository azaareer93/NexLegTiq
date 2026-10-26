import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

import { createApiClient } from './api-client.js';
import { profileApi } from './profile.js';

const ORIGIN = 'http://api.test';
const url = (path: string) => `${ORIGIN}/api/v1/${path}`;
const meta = { timestamp: '2026-10-26T10:00:00.000Z', requestId: 'req-12345678' };
const ok = (data: unknown) => HttpResponse.json({ success: true, data, meta });

const PROFILE = {
  id: '01920000-0000-7000-8000-000000000001',
  fullName: 'Rana Lawyer',
  email: 'rana@example.test',
  role: 'LAWYER',
  phone: null,
  uiLanguage: 'AR',
  timezone: null,
  digitStyle: 'WESTERN',
  avatar: null,
};
const PREFS = [{ category: 'HEARINGS', inApp: true, email: false }];

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const api = () =>
  profileApi(
    createApiClient({
      baseURL: ORIGIN,
      realm: 'office',
      getToken: () => 'access-1',
      setToken: () => undefined,
      onAuthFailure: () => undefined,
    }),
  );

describe('profileApi (D-146)', () => {
  it('should read and change the profile, its picture and the notification preferences', async () => {
    const seen: { method: string; body: unknown }[] = [];
    let uploaded: string[] = [];
    server.use(
      http.get(url('users/me'), () => ok(PROFILE)),
      http.patch(url('users/me'), async ({ request }) => {
        seen.push({ method: 'PATCH', body: await request.json() });
        return ok({ ...PROFILE, uiLanguage: 'EN' });
      }),
      http.post(url('users/me/avatar'), async ({ request }) => {
        uploaded = [...(await request.formData()).keys()];
        return ok({ ...PROFILE, avatar: { url: 'https://storage.test/a', expiresIn: 900 } });
      }),
      http.delete(url('users/me/avatar'), () => ok(PROFILE)),
      http.get(url('notifications/preferences'), () => ok(PREFS)),
      http.patch(url('notifications/preferences'), async ({ request }) => {
        seen.push({ method: 'PATCH prefs', body: await request.json() });
        return ok(PREFS);
      }),
    );
    await expect(api().get()).resolves.toEqual(PROFILE);
    await expect(api().update({ uiLanguage: 'EN' })).resolves.toMatchObject({ uiLanguage: 'EN' });
    const image = new Blob(['png'], { type: 'image/png' });
    await expect(api().uploadAvatar(image, 'me.png')).resolves.toMatchObject({
      avatar: { url: 'https://storage.test/a' },
    });
    expect(uploaded).toEqual(['file']);
    await expect(api().removeAvatar()).resolves.toMatchObject({ avatar: null });
    await expect(api().notificationPreferences()).resolves.toEqual(PREFS);
    await api().updateNotificationPreferences({ HEARINGS: { email: false } });
    expect(seen).toEqual([
      { method: 'PATCH', body: { uiLanguage: 'EN' } },
      { method: 'PATCH prefs', body: { HEARINGS: { email: false } } },
    ]);
  });
});
