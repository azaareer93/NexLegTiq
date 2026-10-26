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
import { ApiBearerAuth, ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  AdminConfirmEnrollmentSchema,
  AdminEnrollmentSchema,
  AdminEnrollSchema,
  AdminLoginSchema,
  AdminProfileSchema,
  AdminSessionSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  AdminConfirmEnrollmentRequest,
  AdminEnrollment,
  AdminEnrollRequest,
  AdminLoginRequest,
  AdminProfile,
  AdminSession,
} from '@nexlegtiq/shared-contracts';
import type { Request, Response } from 'express';
import { ClsService } from 'nestjs-cls';

import { AdminAuthGuard, AdminRealmGuard } from './admin-guards';
import { ADMIN_REFRESH_COOKIE, adminCookieOptions } from './platform-auth.constants';
import { PlatformAuthService } from './platform-auth.service';
import type { AdminSignIn } from './platform-auth.service';
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
const DEAD_SESSION = new Set(['AUTH-004', 'AUTH-005', 'AUTH-006']);

/**
 * The platform admin realm's sign-in (D-145). `@Public()` takes these routes out of the office JWT guard; the realm guard
 * answers 404 while `ADMIN_JWT_SECRET` is unset and applies `ADMIN_IP_ALLOWLIST` to every route, sign-in included.
 */
@ApiTags('admin')
@Public()
@UseGuards(AdminRealmGuard)
@Controller('admin/auth')
export class PlatformAuthController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly config: AppConfig,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'Admin sign-in: password and authenticator (or recovery) code' })
  @ApiZodBody(AdminLoginSchema)
  @ApiZodResponse(200, AdminSessionSchema)
  async login(
    @Body(new ZodValidationPipe(AdminLoginSchema)) body: AdminLoginRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminSession> {
    return this.respond(await this.auth.login(body, this.client(req)), res);
  }

  @Post('enroll')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'First sign-in: the authenticator secret to scan (password required)' })
  @ApiZodBody(AdminEnrollSchema)
  @ApiZodResponse(200, AdminEnrollmentSchema)
  enroll(
    @Body(new ZodValidationPipe(AdminEnrollSchema)) body: AdminEnrollRequest,
    @Req() req: Request,
  ): Promise<AdminEnrollment> {
    return this.auth.enroll(body, this.client(req));
  }

  @Post('enroll/confirm')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @ApiOperation({
    summary:
      'Confirm the authenticator with its first code; signs in and returns recovery codes once',
  })
  @ApiZodBody(AdminConfirmEnrollmentSchema)
  @ApiZodResponse(201, AdminSessionSchema)
  async confirm(
    @Body(new ZodValidationPipe(AdminConfirmEnrollmentSchema)) body: AdminConfirmEnrollmentRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminSession> {
    return this.respond(await this.auth.confirmEnrollment(body, this.client(req)), res);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiCookieAuth('admin-refresh')
  @ApiOperation({ summary: 'Rotate the admin refresh cookie (needs Origin + X-Requested-With)' })
  @ApiZodResponse(200, AdminSessionSchema)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminSession> {
    assertCookieRequestOrigin(req.headers, this.adminOrigins());
    try {
      return this.respond(await this.auth.refresh(this.cookie(req), this.client(req)), res);
    } catch (error) {
      if (error instanceof AppException && DEAD_SESSION.has(error.code)) {
        res.clearCookie(ADMIN_REFRESH_COOKIE, adminCookieOptions());
      }
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: MINUTE_MS } })
  @ApiCookieAuth('admin-refresh')
  @ApiOperation({
    summary: 'End the admin session family and clear the cookie (needs Origin + X-Requested-With)',
  })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    assertCookieRequestOrigin(req.headers, this.adminOrigins());
    await this.auth.logout(this.cookie(req), this.client(req));
    res.clearCookie(ADMIN_REFRESH_COOKIE, adminCookieOptions());
  }

  @Get('me')
  @UseGuards(AdminAuthGuard)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'The signed-in platform admin' })
  @ApiZodResponse(200, AdminProfileSchema)
  me(@Req() req: Request & { platformAdminId?: string }): Promise<AdminProfile> {
    // AdminAuthGuard always sets it; its absence is a wiring error (500), never a lookup of an empty id.
    if (!req.platformAdminId) throw new Error('AdminAuthGuard did not run');
    return this.auth.profile(req.platformAdminId);
  }

  /** Only the admin panel may use the admin cookie — not the office app or the portal (D-145). */
  private adminOrigins(): readonly string[] {
    return this.config.admin?.origins ?? [];
  }

  private respond({ session, issued }: AdminSignIn, res: Response): AdminSession {
    res.cookie(ADMIN_REFRESH_COOKIE, issued.refreshToken, adminCookieOptions(issued.expiresAt));
    return session;
  }

  private cookie(req: Request): string | undefined {
    const value: unknown = (req.cookies as Record<string, unknown> | undefined)?.[
      ADMIN_REFRESH_COOKIE
    ];
    return typeof value === 'string' ? value : undefined;
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
