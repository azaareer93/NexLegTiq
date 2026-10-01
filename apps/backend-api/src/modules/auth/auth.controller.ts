import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AuthSessionSchema, LoginRequestSchema } from '@nexlegtiq/shared-contracts';
import type { AuthSession, LoginRequest } from '@nexlegtiq/shared-contracts';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../../common/context/request-context';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { AppConfig } from '../../config/app-config';
import { Public, REFRESH_COOKIE, refreshCookieOptions } from './auth.constants';
import { AuthService } from './auth.service';
import type { ClientInfo, IssuedSession } from './auth.service';
import { assertCookieRequestOrigin } from './csrf';

const MINUTE_MS = 60_000;

/** `/api/v1/auth` — login, refresh, logout (auth-rbac.md, Flows; D-050, D-053, D-055). */
@ApiTags('auth')
@Public()
@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'Sign in; returns an access token and sets the httpOnly refresh cookie' })
  @ApiZodBody(LoginRequestSchema)
  @ApiZodResponse(200, AuthSessionSchema)
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) body: LoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthSession> {
    return this.respond(await this.auth.login(body, this.client(req)), res);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'Rotate the refresh cookie and get a new access token (needs Origin + X-Requested-With)' })
  @ApiZodResponse(200, AuthSessionSchema)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthSession> {
    assertCookieRequestOrigin(req.headers, this.config.corsOrigins);
    try {
      return this.respond(await this.auth.refresh(this.cookie(req), this.client(req)), res);
    } catch (error) {
      // A refused refresh never leaves a stale cookie behind.
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'Revoke the session family and clear the refresh cookie (needs Origin + X-Requested-With)' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    assertCookieRequestOrigin(req.headers, this.config.corsOrigins);
    await this.auth.logout(this.cookie(req), this.client(req));
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
  }

  private respond(issued: IssuedSession, res: Response): AuthSession {
    res.cookie(REFRESH_COOKIE, issued.refreshToken, refreshCookieOptions(issued.refreshExpiresAt));
    return issued.session;
  }

  private cookie(req: Request): string | undefined {
    const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[REFRESH_COOKIE];
    return typeof value === 'string' ? value : undefined;
  }

  private client(req: Request): ClientInfo {
    return {
      // Behind the proxy chain configured by TRUST_PROXY_HOPS (D-053 lockout and audit use the real client address).
      ip: req.ip ?? '0.0.0.0',
      userAgent: req.get('user-agent') ?? null,
      requestId: this.cls.isActive() ? this.cls.getId() : null,
    };
  }
}
