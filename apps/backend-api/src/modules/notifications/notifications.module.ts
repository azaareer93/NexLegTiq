import { Global, Module } from '@nestjs/common';

import { NotificationService } from './notification.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * In-app notifications (D-149): `NotificationService.notify` for any feature (global, in the API and the worker), and the
 * caller's own notification routes. The `notification` queue's consumer is registered by the worker only.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationService, NotificationsService],
  exports: [NotificationService],
})
export class NotificationsModule {}
