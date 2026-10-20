import { Injectable } from '@nestjs/common';

import { AiProviders } from './ai-providers';
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

  async assertAvailable(): Promise<void> {
    if (!this.providers.configured)
      throw new AppException('AI-001', 'No AI provider is configured');
    const settings = await this.prisma.db.officeSettings.findFirst({ select: { enableAi: true } });
    if (settings?.enableAi === false)
      throw new AppException('AI-005', 'AI is disabled for this office');
    await this.entitlements.assertFeature('ai');
    await this.entitlements.assertAiQuota();
  }
}
