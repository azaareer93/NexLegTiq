import { Injectable } from '@nestjs/common';
import { NotificationSchema } from '@nexlegtiq/shared-contracts';
import type {
  Notification,
  NotificationCount,
  NotificationPage,
  NotificationQuery,
} from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';

const SELECT = {
  id: true,
  type: true,
  titleKey: true,
  params: true,
  link: true,
  readAt: true,
  createdAt: true,
} as const;

type Row = {
  id: string;
  type: string;
  titleKey: string;
  params: unknown;
  link: string | null;
  readAt: Date | null;
  createdAt: Date;
};

/**
 * The caller's own notifications (D-149): every route reads and changes only the signed-in user's rows (scoped client +
 * `userId`), so someone else's notification is 404. Ids are UUID v7, so id order is creation order and the cursor is the
 * last id of a page.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cls: ClsService<RequestContext>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationsService.name);
  }

  async list({ cursor, unread, limit }: NotificationQuery): Promise<NotificationPage> {
    const rows = await this.prisma.db.notification.findMany({
      where: {
        userId: this.userId(),
        ...(unread ? { readAt: null } : {}),
        ...(cursor ? { id: { lt: cursor } } : {}),
      },
      orderBy: { id: 'desc' },
      take: limit + 1,
      select: SELECT,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.flatMap((row) => this.readable(row)),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async unreadCount(): Promise<NotificationCount> {
    const count = await this.prisma.db.notification.count({
      where: { userId: this.userId(), readAt: null },
    });
    return { count };
  }

  /** Marks one as read; reading it again keeps the first time. */
  async markRead(id: string): Promise<Notification> {
    const where = { id, userId: this.userId() };
    await this.prisma.db.notification.updateMany({
      where: { ...where, readAt: null },
      data: { readAt: new Date() },
    });
    const row = await this.prisma.db.notification.findFirst({ where, select: SELECT });
    const [readable] = row ? this.readable(row) : [];
    if (!readable) throw new ResourceNotFoundException();
    return readable;
  }

  async markAllRead(): Promise<NotificationCount> {
    const { count } = await this.prisma.db.notification.updateMany({
      where: { userId: this.userId(), readAt: null },
      data: { readAt: new Date() },
    });
    return { count };
  }

  /** A row the contract cannot read (written by a bug elsewhere) is left out and logged, never a 500 for the whole list. */
  private readable(row: Row): Notification[] {
    const parsed = NotificationSchema.safeParse({
      ...row,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    });
    if (parsed.success) return [parsed.data];
    this.logger.warn({ notificationId: row.id }, 'Unreadable notification left out');
    return [];
  }

  private userId(): string {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the context of notifications');
    return userId;
  }
}
