import { Injectable } from '@nestjs/common';
import { formatDate, formatTime } from '@nexlegtiq/shared-utils';

import { reminderJobId } from './reminder-scheduler';
import { MailService } from '../../common/mail/mail.service';
import { QueueProducer } from '../../common/queue/queue-producer';
import { QUEUE } from '../../common/queue/queues';
import { RealtimePublisher } from '../../common/realtime/realtime.publisher';
import { AppConfig } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { CaseAccessService } from '../legal-files/case-access.service';
import { CREATE_NOTIFICATION_JOB } from '../notifications/notification-job';
import type { NotificationJob } from '../notifications/notification-job';

const DELIVERY_SELECT = {
  id: true,
  status: true,
  daysBefore: true,
  recipient: {
    select: {
      id: true,
      fullName: true,
      email: true,
      isActive: true,
      uiLanguage: true,
      timezone: true,
    },
  },
  session: {
    select: {
      id: true,
      startsAt: true,
      isCancelled: true,
      outcome: true,
      courtRoom: true,
      court: { select: { nameAr: true, nameEn: true } },
      file: {
        select: { id: true, fileNumber: true, title: true, status: true, deletedAt: true },
      },
    },
  },
} satisfies Prisma.SessionReminderSelect;
type ReminderRow = Prisma.SessionReminderGetPayload<{ select: typeof DELIVERY_SELECT }>;

/** What a delivery attempt did (the job's result). */
export type DeliveryResult =
  | { readonly skipped: 'MISSING' | 'NOT_PENDING' }
  | { readonly cancelled: string }
  | { readonly sent: string };

/** The office-app page of a session (the calendar opens its drawer). */
export const sessionPath = (sessionId: string): string => `/calendar?session=${sessionId}`;

/**
 * Worker side of hearing reminders (MVP-68, D-117), run by the reminder processor in the reminder's office. A reminder is
 * sent once: email (recipient's language and zone) and in-app notification are enqueued under ids derived from the
 * reminder — a second run, or a retry after a partial one, adds nothing — and only then is the row marked SENT. A row that
 * is no longer PENDING does nothing; one whose session was cancelled, held or has started, whose file is closed, archived
 * or deleted, or whose recipient was deactivated or can no longer see the file becomes CANCELLED. A reschedule committed
 * between the read and the hand-off can still let the old reminder out (the row then stays CANCELLED); rare, accepted.
 */
@Injectable()
export class ReminderDelivery {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly queues: QueueProducer,
    private readonly config: AppConfig,
    private readonly realtime: RealtimePublisher,
  ) {}

  async deliver(reminderId: string, now = new Date()): Promise<DeliveryResult> {
    const reminder = await this.prisma.db.sessionReminder.findFirst({
      where: { id: reminderId },
      select: DELIVERY_SELECT,
    });
    if (!reminder) return { skipped: 'MISSING' };
    if (reminder.status !== 'PENDING') return { skipped: 'NOT_PENDING' };
    const stale = staleReason(reminder, now) ?? (await this.noAccess(reminder));
    if (stale) {
      await this.setStatus(reminderId, 'CANCELLED');
      return { cancelled: stale };
    }
    await this.send(reminder);
    await this.setStatus(reminderId, 'SENT', now);
    return { sent: reminder.recipient.id };
  }

  /** After the last attempt failed: the reminder is FAILED (unless something else ended it meanwhile). */
  async markFailed(reminderId: string): Promise<void> {
    await this.setStatus(reminderId, 'FAILED');
  }

  /**
   * A recipient who can no longer see the file (made confidential, taken off the team, role lowered) is not told about
   * its hearing (D-096): the same check as for an attending lawyer, by the recipient's own scope.
   */
  private async noAccess(reminder: ReminderRow): Promise<string | null> {
    const allowed = await CaseAccessService.colleagueMay(
      this.prisma.db,
      reminder.recipient.id,
      'view:assigned:cases',
      reminder.session.file.id,
    );
    return allowed ? null : 'RECIPIENT_NO_ACCESS';
  }

  private async send(reminder: ReminderRow): Promise<void> {
    const { recipient, session } = reminder;
    const { timezone: officeZone } = await this.prisma.db.office.findFirstOrThrow({
      select: { timezone: true },
    });
    const timeZone = isTimeZone(recipient.timezone) ? recipient.timezone : officeZone;
    const locale = recipient.uiLanguage === 'EN' ? 'en' : 'ar';
    const court = session.court
      ? locale === 'en'
        ? (session.court.nameEn ?? session.court.nameAr)
        : session.court.nameAr
      : '';
    const jobId = reminderJobId(reminder.id);
    await this.mail.send(
      recipient.email,
      'hearing-reminder',
      recipient.uiLanguage,
      {
        name: recipient.fullName,
        link: `${this.config.mail.officeAppUrl}${sessionPath(session.id)}`,
        fileNumber: session.file.fileNumber,
        fileTitle: session.file.title,
        date: formatDate(session.startsAt, { locale, timeZone, style: 'long' }),
        time: formatTime(session.startsAt, { locale, timeZone }),
        court,
        courtRoom: session.courtRoom ?? '',
      },
      { jobId: `${jobId}-email` },
    );
    await this.queues.enqueue<NotificationJob>(
      QUEUE.NOTIFICATION,
      CREATE_NOTIFICATION_JOB,
      {
        userId: recipient.id,
        type: 'SESSION_REMINDER',
        titleKey: 'shell.notifications.hearingReminder',
        params: {
          fileNumber: session.file.fileNumber,
          startsAt: session.startsAt.toISOString(),
          daysBefore: reminder.daysBefore,
          sessionId: session.id,
        },
        link: sessionPath(session.id),
      },
      { jobId: `${jobId}-notification` },
    );
    this.realtime.toUser(recipient.id, 'session.reminder', {
      sessionId: session.id,
      reminderId: reminder.id,
    });
  }

  private async setStatus(
    id: string,
    status: 'SENT' | 'FAILED' | 'CANCELLED',
    sentAt?: Date,
  ): Promise<void> {
    await this.prisma.db.sessionReminder.updateMany({
      where: { id, status: 'PENDING' },
      data: { status, ...(sentAt && { sentAt }) },
    });
  }
}

/** Why a PENDING reminder must not be sent any more, or null. */
function staleReason(reminder: ReminderRow, now: Date): string | null {
  const { session, recipient } = reminder;
  if (session.isCancelled) return 'SESSION_CANCELLED';
  if (session.outcome) return 'SESSION_HELD';
  if (session.startsAt <= now) return 'SESSION_STARTED';
  if (session.file.deletedAt) return 'FILE_DELETED';
  if (session.file.status === 'CLOSED' || session.file.status === 'ARCHIVED') return 'FILE_CLOSED';
  if (!recipient.isActive) return 'RECIPIENT_INACTIVE';
  return null;
}

/** A user's zone is optional and set by the profile; an unknown one falls back to the office's (as in the UI, D-092). */
function isTimeZone(zone: string | null): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
