import type { Request, Response } from 'express';
import type { ClsService } from 'nestjs-cls';

import { PortalAccessController } from './portal-access.controller';
import type { PortalAccessService } from './portal-access.service';
import { PORTAL_REFRESH_COOKIE } from './portal-auth.constants';
import { PortalAuthController } from './portal-auth.controller';
import type { PortalAuthService } from './portal-auth.service';
import type { PortalInvitationAcceptService } from './portal-invitation-accept.service';
import type { RequestContext } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import type { AppConfig } from '../../config/app-config';

const ORIGIN = 'https://portal.example.test';
const signIn = {
  session: {
    accessToken: 'at',
    expiresIn: 900,
    user: { id: 'u1', fullName: 'L', email: 'l@x.test', offices: [] },
  },
  issued: { refreshToken: 'rt', familyId: 'f', expiresAt: new Date('2026-11-16T00:00:00Z') },
};
const csrf = { origin: ORIGIN, 'x-requested-with': 'XMLHttpRequest' };
const req = (headers: Record<string, string> = {}, cookies: Record<string, unknown> = {}) =>
  ({ headers, cookies, ip: '203.0.113.7', get: () => 'jest' }) as unknown as Request;

function setup(portal: AppConfig['portal'] = { jwtSecret: 's', origin: ORIGIN }, cls = true) {
  const auth = {
    login: jest.fn().mockResolvedValue(signIn),
    refresh: jest.fn().mockResolvedValue(signIn),
    logout: jest.fn(),
    profile: jest.fn().mockResolvedValue(signIn.session.user),
    forgotPassword: jest.fn(),
    resetPassword: jest.fn(),
  };
  const invitations = {
    preview: jest.fn().mockResolvedValue({ email: 'l@x.test' }),
    accept: jest.fn().mockResolvedValue(signIn),
  };
  const controller = new PortalAuthController(
    auth as unknown as PortalAuthService,
    invitations as unknown as PortalInvitationAcceptService,
    { portal } as unknown as AppConfig,
    { isActive: () => cls, getId: () => 'req-12345678' } as unknown as ClsService<RequestContext>,
  );
  const res = { cookie: jest.fn(), clearCookie: jest.fn() };
  return { controller, auth, invitations, res: res as unknown as Response & typeof res };
}

describe('PortalAuthController (D-157)', () => {
  it('should set the portal cookie on sign-in and accept, and answer the session', async () => {
    const { controller, res } = setup();
    await expect(controller.login({ email: 'l@x.test', password: 'pw' }, req(), res)).resolves.toBe(
      signIn.session,
    );
    await controller.accept(
      {
        token: 't'.repeat(20),
        fullName: 'L',
        password: 'p',
        acceptTerms: true,
        acceptPrivacy: true,
      },
      req(),
      res,
    );
    expect(res.cookie).toHaveBeenCalledWith(
      PORTAL_REFRESH_COOKIE,
      'rt',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/api/v1/portal/auth' }),
    );
    await expect(controller.preview({ token: 't'.repeat(20) })).resolves.toEqual({
      email: 'l@x.test',
    });
  });

  it('should refuse a cookie request from another origin and clear the cookie only for a dead session', async () => {
    const { controller, auth, res } = setup();
    await expect(controller.refresh(req(), res)).rejects.toMatchObject({ code: 'AUTH-100' });
    await expect(
      controller.refresh(req(csrf, { [PORTAL_REFRESH_COOKIE]: 'rt' }), res),
    ).resolves.toBe(signIn.session);
    expect(auth.refresh).toHaveBeenCalledWith('rt', expect.anything());
    await controller.refresh(req(csrf, { [PORTAL_REFRESH_COOKIE]: 42 }), res);
    expect(auth.refresh).toHaveBeenLastCalledWith(undefined, expect.anything());

    auth.refresh.mockRejectedValueOnce(new AppException('AUTH-005', 'x'));
    await expect(controller.refresh(req(csrf), res)).rejects.toMatchObject({ code: 'AUTH-005' });
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
    auth.refresh.mockRejectedValueOnce(new AppException('RATE-001', 'x'));
    await expect(controller.refresh(req(csrf), res)).rejects.toMatchObject({ code: 'RATE-001' });
    auth.refresh.mockRejectedValueOnce(new Error('boom'));
    await expect(controller.refresh(req(csrf), res)).rejects.toThrow('boom');
    expect(res.clearCookie).toHaveBeenCalledTimes(1);
    // The realm is off: no origin is allowed.
    await expect(setup(null).controller.refresh(req(csrf), setup().res)).rejects.toMatchObject({
      code: 'AUTH-100',
    });
  });

  it('should log out, forget a password, reset it and return the profile', async () => {
    const { controller, auth, res } = setup(undefined, false);
    await controller.logout(req(csrf, { [PORTAL_REFRESH_COOKIE]: 'rt' }), res);
    expect(auth.logout).toHaveBeenCalledWith('rt', expect.objectContaining({ requestId: null }));
    expect(res.clearCookie).toHaveBeenCalled();
    await expect(controller.logout(req(), res)).rejects.toMatchObject({ code: 'AUTH-100' });
    await controller.forgot({ email: 'l@x.test' }, req());
    await controller.reset(
      { token: 't'.repeat(20), newPassword: 'p', confirmPassword: 'p' },
      req(),
    );
    expect(auth.forgotPassword).toHaveBeenCalled();
    expect(auth.resetPassword).toHaveBeenCalled();
    await expect(controller.me({ clientUserId: 'u1' } as never)).resolves.toBe(signIn.session.user);
    expect(() => controller.me({} as never)).toThrow('PortalAuthGuard did not run');
  });
});

describe('PortalAccessController (D-157)', () => {
  it('should hand the client id, body and request facts to the service', async () => {
    const access = {
      invite: jest.fn().mockResolvedValue({ id: 'i' }),
      revokeInvitation: jest.fn(),
      list: jest.fn().mockResolvedValue({ users: [], invitations: [] }),
      revokeAccess: jest.fn(),
    };
    const controller = new PortalAccessController(
      access as unknown as PortalAccessService,
      {
        getId: () => 'req-12345678',
      } as unknown as ClsService<RequestContext>,
    );
    await controller.invite('c1', { email: 'a@b.test' }, req());
    await controller.revokeInvitation('c1', 'i1', req());
    await controller.list('c1');
    await controller.revoke('c1', 'a1', req());
    expect(access.invite).toHaveBeenCalledWith(
      'c1',
      { email: 'a@b.test' },
      expect.objectContaining({ requestId: 'req-12345678' }),
    );
    expect(access.revokeInvitation).toHaveBeenCalledWith('c1', 'i1', expect.anything());
    expect(access.list).toHaveBeenCalledWith('c1');
    expect(access.revokeAccess).toHaveBeenCalledWith('c1', 'a1', expect.anything());
  });
});
