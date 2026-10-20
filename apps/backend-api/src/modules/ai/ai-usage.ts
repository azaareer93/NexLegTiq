import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../../common/context/request-context';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';

export interface UsageEntry {
  readonly feature: string;
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly durationMs: number;
  readonly cached: boolean;
  readonly userId: string | null;
  /** USD, summed over the calls (`cost` per call). */
  readonly costUsd: string;
}

/**
 * One AiUsage row per AI answer (ai-ocr.md CostTracker, D-130): provider calls count against the monthly quota, cache
 * hits are recorded for the record only. The cost comes from `AI_MODEL_PRICES` (USD per million tokens); a model not
 * listed costs 0 — the tokens stay, so the cost can be recomputed later.
 */
@Injectable()
export class AiUsageRecorder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly cls: ClsService<RequestContext>,
  ) {}

  async record(entry: UsageEntry): Promise<void> {
    const officeId = this.cls.get('officeId');
    if (!officeId) throw new Error('No office in the context of an AI usage record');
    await this.prisma.db.aiUsage.create({
      data: { ...entry, officeId },
    });
  }

  /** The cost of one call, by the configured model name (the price key). */
  cost(priceModel: string, inputTokens: number, outputTokens: number): Decimal {
    const price = this.config.ai.prices[priceModel];
    if (!price) return new Decimal(0);
    return new Decimal(inputTokens)
      .mul(price.input)
      .plus(new Decimal(outputTokens).mul(price.output))
      .div(1_000_000);
  }
}
