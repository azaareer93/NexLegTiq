import { Body, Controller, Delete, Get, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  NotificationPreferencesSchema,
  ProfileSchema,
  UpdateNotificationPreferencesSchema,
  UpdateProfileSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  NotificationPreferences,
  Profile,
  UpdateNotificationPreferencesRequest,
  UpdateProfileRequest,
} from '@nexlegtiq/shared-contracts';
import type { Request } from 'express';
import { z } from 'zod';

import { ProfileService } from './profile.service';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodBody, ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { discardBody, readUpload } from '../documents/upload/multipart';
import { AllowWhenReadOnly } from '../subscriptions/subscription.decorators';

const MINUTE_MS = 60_000;

/**
 * The signed-in user's own profile and notification preferences (D-146). No permission decorator: every office user may
 * read and change their own account. Language, time zone, digits and preferences stay changeable while the office is
 * read-only (D-122: the caller's own account); a new avatar is a stored file, so it is not.
 */
@ApiTags('users')
@ApiBearerAuth('JWT')
@Controller()
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get('users/me')
  @ApiOperation({ summary: 'Your own profile (the avatar as a 15-minute link)' })
  @ApiZodResponse(200, ProfileSchema)
  get(): Promise<Profile> {
    return this.profile.get();
  }

  @AllowWhenReadOnly()
  @Patch('users/me')
  @ApiOperation({
    summary: 'Change your name, phone, language, time zone or digits (only the fields sent)',
  })
  @ApiZodBody(UpdateProfileSchema)
  @ApiZodResponse(200, ProfileSchema)
  update(
    @Body(new ZodValidationPipe(UpdateProfileSchema)) body: UpdateProfileRequest,
  ): Promise<Profile> {
    return this.profile.update(body);
  }

  @Post('users/me/avatar')
  @Throttle({ default: { limit: 10, ttl: MINUTE_MS } })
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Upload your picture: PNG or JPEG, ≤ 2 MB (413 VAL-006), ≤ 2048×2048 (400 VAL-001); 415 VAL-005 otherwise',
  })
  @ApiZodResponse(201, ProfileSchema)
  async avatar(@Req() req: Request): Promise<Profile> {
    const { file } = await readUpload(req, z.object({}));
    try {
      return await this.profile.setAvatar(file);
    } finally {
      await discardBody(req);
    }
  }

  @Delete('users/me/avatar')
  @ApiOperation({ summary: 'Remove your picture' })
  @ApiZodResponse(200, ProfileSchema)
  removeAvatar(): Promise<Profile> {
    return this.profile.removeAvatar();
  }

  @Get('notifications/preferences')
  @ApiOperation({ summary: 'Your notification channels per category (on unless turned off)' })
  @ApiZodResponse(200, NotificationPreferencesSchema)
  preferences(): Promise<NotificationPreferences> {
    return this.profile.preferences();
  }

  @AllowWhenReadOnly()
  @Patch('notifications/preferences')
  @ApiOperation({ summary: 'Turn notification channels on or off, per category' })
  @ApiZodBody(UpdateNotificationPreferencesSchema)
  @ApiZodResponse(200, NotificationPreferencesSchema)
  updatePreferences(
    @Body(new ZodValidationPipe(UpdateNotificationPreferencesSchema))
    body: UpdateNotificationPreferencesRequest,
  ): Promise<NotificationPreferences> {
    return this.profile.updatePreferences(body);
  }
}
