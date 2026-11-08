import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  NotificationCountSchema,
  NotificationPageSchema,
  NotificationQuerySchema,
  NotificationSchema,
} from '@nexlegtiq/shared-contracts';
import type {
  Notification,
  NotificationCount,
  NotificationPage,
  NotificationQuery,
} from '@nexlegtiq/shared-contracts';

import { NotificationsService } from './notifications.service';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe';
import { ApiZodResponse } from '../../common/openapi/api-zod.decorators';
import { AllowWhenReadOnly } from '../subscriptions/subscription.decorators';

const notificationId = new ParseUUIDPipe({
  exceptionFactory: () => new ResourceNotFoundException(),
});

/**
 * The signed-in user's notifications (D-149, api-conventions.md). No permission decorator: everyone reads their own.
 * Marking read stays possible while the office is read-only (D-122: a "seen" mark, like a reminder acknowledgement).
 */
@ApiTags('notifications')
@ApiBearerAuth('JWT')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Your notifications, newest first (cursor = nextCursor of the previous page)',
  })
  @ApiZodResponse(200, NotificationPageSchema)
  list(
    @Query(new ZodValidationPipe(NotificationQuerySchema)) query: NotificationQuery,
  ): Promise<NotificationPage> {
    return this.notifications.list(query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'How many of your notifications are unread' })
  @ApiZodResponse(200, NotificationCountSchema)
  unreadCount(): Promise<NotificationCount> {
    return this.notifications.unreadCount();
  }

  @Post('read-all')
  @HttpCode(200)
  @AllowWhenReadOnly()
  @ApiOperation({ summary: 'Mark all your notifications read (count = how many were unread)' })
  @ApiZodResponse(200, NotificationCountSchema)
  markAllRead(): Promise<NotificationCount> {
    return this.notifications.markAllRead();
  }

  @Post(':id/read')
  @HttpCode(200)
  @AllowWhenReadOnly()
  @ApiOperation({ summary: 'Mark one of your notifications read (someone else’s → 404)' })
  @ApiZodResponse(200, NotificationSchema)
  markRead(@Param('id', notificationId) id: string): Promise<Notification> {
    return this.notifications.markRead(id);
  }
}
