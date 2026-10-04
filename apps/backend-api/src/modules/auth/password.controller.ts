import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ChangePasswordRequestSchema, ForgotPasswordRequestSchema, ResetPasswordRequestSchema } from '@nexlegtiq/shared-contracts';
import type { ChangePasswordRequest, ForgotPasswordRequest, ResetPasswordRequest } from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { ClsService } from 'nestjs-cls';

import { Public } from '../../common/auth/public.decorator';
import type { AuthPrincipal, RequestContext } from '../../common/context/request-context';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody } from '../../common/openapi/api-zod.decorators';
import { clientFromRequest } from './client-info';
import type { ClientInfo } from './client-info';
import { PasswordService } from './password.service';

const MINUTE_MS = 60_000;

/** Forgot / reset / change password (MVP-41; auth-rbac.md Flows; D-086). 5 requests a minute per IP on each. */
@ApiTags('auth')
@Controller()
export class PasswordController {
  constructor(
    private readonly passwords: PasswordService,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  @Public()
  @Post('auth/forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'Email a password-reset link; always 200, whether or not the email has an account' })
  @ApiZodBody(ForgotPasswordRequestSchema)
  @ApiOkResponse({ description: 'Accepted (an email is sent only to an active account)' })
  async forgotPassword(@Body(new ZodValidationPipe(ForgotPasswordRequestSchema)) body: ForgotPasswordRequest, @Req() req: Request): Promise<void> {
    await this.passwords.forgotPassword(body, this.client(req));
  }

  @Public()
  @Post('auth/reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @ApiOperation({ summary: 'Set a new password with the emailed link; ends every session (410 RES-004 if the link is invalid)' })
  @ApiZodBody(ResetPasswordRequestSchema)
  @ApiNoContentResponse({ description: 'Password changed; sign in again' })
  async resetPassword(@Body(new ZodValidationPipe(ResetPasswordRequestSchema)) body: ResetPasswordRequest, @Req() req: Request): Promise<void> {
    await this.passwords.resetPassword(body, this.client(req));
  }

  @Post('users/me/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: MINUTE_MS } })
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Change your own password; ends your other sessions (400 VAL-001 if the current password is wrong)' })
  @ApiZodBody(ChangePasswordRequestSchema)
  @ApiNoContentResponse({ description: 'Password changed; this session stays signed in' })
  async changePassword(
    @Body(new ZodValidationPipe(ChangePasswordRequestSchema)) body: ChangePasswordRequest,
    @Req() req: Request & { user: AuthPrincipal },
  ): Promise<void> {
    await this.passwords.changePassword(req.user, body, this.client(req));
  }

  private client(req: Request): ClientInfo {
    return clientFromRequest(req, this.cls.isActive() ? this.cls.getId() : null);
  }
}
