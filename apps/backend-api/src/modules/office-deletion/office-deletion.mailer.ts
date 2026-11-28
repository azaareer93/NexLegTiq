import { Injectable } from '@nestjs/common';
import { wallClock } from '@nexlegtiq/shared-utils';
import { PinoLogger } from 'nestjs-pino';

import { MailService } from '../../common/mail/mail.service';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';

export type DeletionEvent = 'requested' | 'cancelled' | 'rescheduled';

/**
 * Tells every active office manager of a request, cancel or new date (D-251), each in their own language, after the change
 * committed. A failure is logged, never shown: the change itself is done and audited.
 */
@Injectable()
export class OfficeDeletionMailer {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: AppConfig,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OfficeDeletionMailer.name);
  }

  async notify(officeId: string, event: DeletionEvent, scheduledFor: Date | null): Promise<void> {
    try {
      // unscoped: also called from the platform realm, which has no office context; the office id is the caller's own.
      const raw = this.prisma.unscoped();
      const [office, managers] = await Promise.all([
        raw.office.findUniqueOrThrow({
          where: { id: officeId },
          select: { name: true, timezone: true },
        }),
        raw.user.findMany({
          where: { officeId, role: 'OFFICE_MANAGER', isActive: true },
          select: { email: true, fullName: true, uiLanguage: true },
        }),
      ]);
      const date = scheduledFor ? wallClock(scheduledFor, office.timezone).date : '';
      for (const manager of managers) {
        await this.mail.send(manager.email, `office-deletion-${event}`, manager.uiLanguage, {
          name: manager.fullName,
          officeName: office.name,
          link: `${this.config.mail.officeAppUrl}/settings`,
          date,
        });
      }
    } catch (error) {
      this.logger.warn({ err: error, officeId, event }, 'Office deletion email not queued');
    }
  }
}
