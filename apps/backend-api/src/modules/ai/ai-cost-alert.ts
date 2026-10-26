import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { PinoLogger } from 'nestjs-pino';

import { MailTransport } from '../../common/mail/mail-transport';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';

export const AI_COST_ALERT_JOB = 'ai-cost-alert';
/** Daily at 06:00 UTC, over the UTC day that just ended (morning in Palestine). */
export const AI_COST_ALERT_SCHEDULE = { pattern: '0 6 * * *', tz: 'UTC' } as const;

const DAY_MS = 86_400_000;

export interface CostCheck {
  /** The UTC day checked, `YYYY-MM-DD`. */
  readonly day: string;
  readonly costUsd: string;
  readonly alerted: boolean;
}

/**
 * The daily platform AI cost check (D-144): the cost of every office's AI calls on the previous UTC day, against
 * `AI_COST_ALERT_THRESHOLD_USD`. Above it, the founder gets an email (through the mail transport directly: this job
 * belongs to no office) and an error is logged — the error tracker picks it up once monitoring exists (its own story).
 */
@Injectable()
export class AiCostAlert {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfig,
    private readonly transport: MailTransport,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AiCostAlert.name);
  }

  async run(now = new Date()): Promise<CostCheck | null> {
    const alert = this.config.aiCostAlert;
    if (!alert) return null;
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(end.getTime() - DAY_MS);
    const day = start.toISOString().slice(0, 10);
    // unscoped: the platform's total over every office; only the sum leaves the query.
    const { _sum } = await this.prisma.unscoped().aiUsage.aggregate({
      where: { createdAt: { gte: start, lt: end } },
      _sum: { costUsd: true },
    });
    const cost = new Decimal(_sum.costUsd?.toString() ?? '0');
    const costUsd = cost.toFixed(2);
    if (cost.lte(alert.thresholdUsd)) return { day, costUsd, alerted: false };
    const threshold = new Decimal(alert.thresholdUsd).toFixed(2);
    this.logger.error(
      { day, costUsd, thresholdUsd: threshold },
      'AI cost above the daily threshold',
    );
    const text = `NexLegTiq AI cost on ${day} (UTC): ${costUsd} USD, above the alert threshold of ${threshold} USD.`;
    await this.transport.send(alert.email, {
      subject: `AI cost alert: ${costUsd} USD on ${day}`,
      text,
      html: `<p>${text}</p>`,
    });
    return { day, costUsd, alerted: true };
  }
}
