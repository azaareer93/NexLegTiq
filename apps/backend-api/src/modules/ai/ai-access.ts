import { Injectable } from '@nestjs/common';

import { AiFinalException, AiProviders } from './ai-providers';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';
import { EntitlementsService } from '../subscriptions/entitlements.service';

/**
 * May this office use AI now (D-130)? Checked before a job is queued and again before every provider call:
 * no provider configured → AI-001; the office switched AI off (`enableAi`) → AI-005; the plan has no AI → AUTH-102;
 * the month's quota used → AUTH-103.
 */
@Injectable()
export class AiAccess {
  constructor(
    private readonly providers: AiProviders,
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Everything, before work is queued. */
  async assertAvailable(): Promise<void> {
    await this.assertEnabled();
    await this.assertQuota();
  }

  /** Configured, switched on by the office and in the plan — checked before the cache. */
  async assertEnabled(): Promise<void> {
    if (!this.providers.configured) {
      throw new AiFinalException('AI-001', 'No AI provider is configured');
    }
    const settings = await this.prisma.db.officeSettings.findFirst({ select: { enableAi: true } });
    if (settings?.enableAi === false) {
      throw new AppException('AI-005', 'AI is disabled for this office');
    }
    await this.entitlements.assertFeature('ai');
  }

  /** The month's quota — checked only before a provider call: a cached answer is free. */
  assertQuota(): Promise<void> {
    return this.entitlements.assertAiQuota();
  }
}
