import { Global, Module } from '@nestjs/common';

import { EntitlementsService } from './entitlements.service';
import { StorageUsageService } from './storage-usage.service';
import { SubscriptionGuard } from './subscription.guard';
import { SubscriptionsController } from './subscriptions.controller';

/**
 * Plan entitlements, quota checks and read-only mode (D-005, D-122). Global: every feature that adds users, bytes or AI
 * requests checks its quota here, and `SubscriptionGuard` is an app guard.
 */
@Global()
@Module({
  controllers: [SubscriptionsController],
  providers: [EntitlementsService, StorageUsageService, SubscriptionGuard],
  exports: [EntitlementsService, StorageUsageService, SubscriptionGuard],
})
export class SubscriptionsModule {}
