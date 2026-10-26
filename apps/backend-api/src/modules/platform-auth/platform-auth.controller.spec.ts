import type { Request, Response } from 'express';
import type { ClsService } from 'nestjs-cls';

import { ADMIN_REFRESH_COOKIE } from './platform-auth.constants';
import { PlatformAuthController } from './platform-auth.controller';
import type { PlatformAuthService } from './platform-auth.service';
import type { RequestContext } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import type { AppConfig } from '../../config/app-config';

const ORIGIN = 'https://admin.example.test';
const signIn = {
  session: {
    accessToken: 'at',
    expiresIn: 900,
    admin: { id: 'a1', fullName: 'A', email: 'a@x.test' },
  },
  issued: { refreshToken: 'rt', familyId: 'f', expiresAt: new Date('2026-10-26T18:00:00Z') },
};

function setup() {
  const auth = {
    login: jest.fn().mockResolvedValue(signIn),
    confirmEnrollment: jest.fn().mockResolvedValue(signIn),
    enroll: jest.fn().mockResolvedValue({ otpauthUri: 'otpauth://totp/x', secret: 'S' }),
    refresh: jest.fn().mockResolvedValue(signIn),
    logout: jest.fn(),
    profile: jest.fn().mockResolvedValue(signIn.session.admin),
  };
  const cls = { isActive: () => true, getId: () => 'req-12345678' };
  const controller = new PlatformAuthController(
    auth as unknown as PlatformAuthService,
    { corsOrigins: [ORIGIN] } as unknown as AppConfig,
    cls as unknown as ClsService<RequestContext>,
  );
  const res = { cookie: jest.fn(), clearCookie: jest.fn() };
  const req = (headers: Record<string, string> = {}, cookies: Record<string, unknown> = {}) =>
    ({ headers, cookies, ip: '203.0.113.7', get: () => 'jest' }) as unknown as Request;
  return { controller, auth, res: res as unknown as Response & typeof res, req };
}

const csrf = { origin: ORIGIN, 'x-requested-with': 'XMLHttpRequest' };

describe('PlatformAuthController (D-145)', () => {
  it('should set the admin cookie on sign-in and confirmation, and answer the session', async () => {
    const { controller, res, req } = setup();
    const body = { email: 'a@x.test', password: 'pw' };
    await expect(controller.login({ ...body, code: '123456' }, req(), res)).resolves.toBe(
      signIn.session,
    );
    await controller.confirm({ ...body, code: '123456' }, req(), res);
    expect(res.cookie).toHaveBeenCalledWith(
      ADMIN_REFRESH_COOKIE,
      'rt',
      expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/api/v1/admin/auth' }),
    );
    await expect(controller.enroll(body, req())).resolves.toMatchObject({ secret: 'S' });
  });

  it('should refresh only from the admin app with the cookie, and clear it when the session is dead', async () => {
    const { controller, auth, res, req } = setup();
    await expect(controller.refresh(req(), res)).rejects.toMatchObject({ code: 'AUTH-100' });
    await controller.refresh(req(csrf, { [ADMIN_REFRESH_COOKIE]: 'rt' }), res);
    expect(auth.refresh).toHaveBeenCalledWith('rt');
    auth.refresh.mockRejectedValueOnce(new AppException('AUTH-004', 'ended'));
    await expect(
      controller.refresh(req(csrf, { [ADMIN_REFRESH_COOKIE]: 7 }), res),
    ).rejects.toMatchObject({ code: 'AUTH-004' });
    expect(auth.refresh).toHaveBeenLastCalledWith(undefined);
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
    auth.refresh.mockRejectedValueOnce(new Error('outage'));
    await expect(controller.refresh(req(csrf), res)).rejects.toThrow('outage');
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
  });

  it('should sign out (clearing the cookie) and show the signed-in admin', async () => {
    const { controller, auth, res, req } = setup();
    await controller.logout(req(csrf, { [ADMIN_REFRESH_COOKIE]: 'rt' }), res);
    expect(auth.logout).toHaveBeenCalledWith(
      'rt',
      expect.objectContaining({ requestId: 'req-12345678' }),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(ADMIN_REFRESH_COOKIE, expect.any(Object));
    const me = req();
    (me as unknown as { platformAdminId: string }).platformAdminId = 'a1';
    await expect(controller.me(me)).resolves.toMatchObject({ id: 'a1' });
  });
});
