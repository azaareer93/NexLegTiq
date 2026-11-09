import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  ForgotPasswordRequestSchema,
  PortalAcceptInviteRequestSchema,
  PortalInvitePreviewRequestSchema,
  PortalInvitePreviewSchema,
  PortalLoginRequestSchema,
  PortalSessionSchema,
  PortalUserSchema,
  ResetPasswordRequestSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  ForgotPasswordRequest,
  PortalAcceptInviteRequest,
  PortalInvitePreview,
  PortalInvitePreviewRequest,
  PortalLoginRequest,
  PortalSession,
  PortalUser,
  ResetPasswordRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';

import { PORTAL_REFRESH_COOKIE, portalCookieOptions } from './portal-auth.constants';
import { PortalAuthService } from './portal-auth.service';
import type { PortalSignIn } from './portal-auth.service';
import { PortalAuthGuard, PortalRealmGuard } from './portal-guards';
import { PortalInvitationAcceptService } from './portal-invitation-accept.service';
import { Public } from '../../common/auth/public.decorator';
import type { RequestContext } from '../../common/context/request-context';
import { AppException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { AppConfig } from '../../config/app-config';
import { clientFromRequest } from '../auth/client-info';
import type { ClientInfo } from '../auth/client-info';
import { assertCookieRequestOrigin } from '../auth/csrf';

const MINUTE_MS = 60_000;
/** Refusals that mean the cookie is dead; anything else (CSRF, rate limit, outage) leaves it alone. */
const DEAD_COOKIE_CODES = new Set(['AUTH-004', 'AUTH-005', 'AUTH-006']);

/**
 * `/api/v1/portal/auth` — the client-portal realm's sign-in, invitations, refresh, logout and password reset (D-158).
 * `@Public()` takes these routes out of the office JWT guard; the realm guard answers 404 while `JWT_PORTAL_SECRET` is
 * unset. Only `me` needs a portal access token.
 */
@ApiTags('portal-auth')
@Public()
@UseGuards(PortalRealmGuard)
@Controller('portal/auth')
export class PortalAuthController {
  constructor(
    private readonly auth: PortalAuthService,
    private readonly invitations: PortalInvitationAcceptService,
    private readonly config: AppConfig,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Post('invites/preview')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'Preview a portal invitation from its link (410 RES-004 if invalid)' })
  @ApiZodBody(PortalInvitePreviewRequestSchema)
  @ApiZodResponse(200, PortalInvitePreviewSchema)
  preview(
    @Body(new ZodValidationPipe(PortalInvitePreviewRequestSchema))
    body: PortalInvitePreviewRequest,
  ): Promise<PortalInvitePreview> {
    return this.invitations.preview(body.token);
  }

  @Post('accept-invite')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @ApiOperation({
    summary:
      'Accept a portal invitation (new account, or the existing account password) and sign in',
  })
  @ApiZodBody(PortalAcceptInviteRequestSchema)
  @ApiZodResponse(201, PortalSessionSchema)
  async accept(
    @Body(new ZodValidationPipe(PortalAcceptInviteRequestSchema)) body: PortalAcceptInviteRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PortalSession> {
    return this.respond(await this.invitations.accept(body, this.client(req)), res);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'Portal sign-in; returns an access token and sets the refresh cookie' })
  @ApiZodBody(PortalLoginRequestSchema)
  @ApiZodResponse(200, PortalSessionSchema)
  async login(
    @Body(new ZodValidationPipe(PortalLoginRequestSchema)) body: PortalLoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PortalSession> {
    return this.respond(await this.auth.login(body, this.client(req)), res);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiCookieAuth('portal-refresh')
  @ApiOperation({ summary: 'Rotate the portal refresh cookie (needs Origin + X-Requested-With)' })
  @ApiZodResponse(200, PortalSessionSchema)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PortalSession> {
    this.assertOrigin(req);
    try {
      return this.respond(await this.auth.refresh(this.cookie(req), this.client(req)), res);
    } catch (error) {
      if (error instanceof AppException && DEAD_COOKIE_CODES.has(error.code)) {
        res.clearCookie(PORTAL_REFRESH_COOKIE, portalCookieOptions());
      }
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiCookieAuth('portal-refresh')
  @ApiOperation({
    summary: 'End the portal session and clear the cookie (needs Origin + X-Requested-With)',
  })
  @ApiNoContentResponse({ description: 'Signed out (also when there was no live session)' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    this.assertOrigin(req);
    await this.auth.logout(this.cookie(req), this.client(req));
    res.clearCookie(PORTAL_REFRESH_COOKIE, portalCookieOptions());
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @ApiOperation({
    summary: 'Send a reset link; always 200, whether or not the email has an account',
  })
  @ApiZodBody(ForgotPasswordRequestSchema)
  @ApiAcceptedResponse({ description: 'Accepted' })
  async forgot(
    @Body(new ZodValidationPipe(ForgotPasswordRequestSchema)) body: ForgotPasswordRequest,
    @Req() req: Request,
  ): Promise<void> {
    await this.auth.forgotPassword(body, this.client(req));
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'Set a new password with the emailed link (410 RES-004 if invalid)' })
  @ApiZodBody(ResetPasswordRequestSchema)
  @ApiNoContentResponse({ description: 'Password changed; every portal session ended' })
  async reset(
    @Body(new ZodValidationPipe(ResetPasswordRequestSchema)) body: ResetPasswordRequest,
    @Req() req: Request,
  ): Promise<void> {
    await this.auth.resetPassword(body, this.client(req));
  }

  @Get('me')
  @UseGuards(PortalAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'The signed-in portal account and the offices it may enter' })
  @ApiZodResponse(200, PortalUserSchema)
  me(@Req() req: Request & { clientUserId?: string }): Promise<PortalUser> {
    // PortalAuthGuard always sets it; its absence is a wiring error (500), never a lookup of an empty id.
    if (!req.clientUserId) throw new Error('PortalAuthGuard did not run');
    return this.auth.profile(req.clientUserId);
  }

  /** Only the portal may use the portal cookie (D-055, D-158). */
  private assertOrigin(req: Request): void {
    const origin = this.config.portal?.origin;
    assertCookieRequestOrigin(req.headers, origin ? [origin] : []);
  }

  private respond({ session, issued }: PortalSignIn, res: Response): PortalSession {
    res.cookie(PORTAL_REFRESH_COOKIE, issued.refreshToken, portalCookieOptions(issued.expiresAt));
    return session;
  }

  private cookie(req: Request): string | undefined {
    const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[
      PORTAL_REFRESH_COOKIE
    ];
    return typeof value === 'string' ? value : undefined;
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
