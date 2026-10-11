import { Injectable } from '@nestjs/common';
import type { SessionReminder } from '@nexlegtiq/shared-contracts';
import { ClsService } from 'nestjs-cls';

import { REMINDER_SELECT, toReminder } from './sessions.repository';
import type { RequestContext } from '../../common/context/request-context';
import { ResourceNotFoundException } from '../../common/errors/app.exception';
import { PrismaService } from '../../database/prisma.service';

/** What a recipient does with their hearing reminders (MVP-68, D-117). */
@Injectable()
export class SessionRemindersService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * The recipient acknowledges one of their sent reminders ("seen"); acknowledging again keeps the first time, and a
   * reminder not sent (yet) is returned unchanged. Someone else's reminder is 404 (D-019).
   */
  async acknowledge(id: string): Promise<SessionReminder> {
    const userId = this.cls.get('userId');
    if (!userId) throw new Error('No caller in the request context');
    const where = { id, recipientId: userId };
    await this.prisma.db.sessionReminder.updateMany({
      where: { ...where, status: 'SENT', acknowledgedAt: null },
      data: { acknowledgedAt: new Date() },
    });
    const reminder = await this.prisma.db.sessionReminder.findFirst({
      where,
      select: REMINDER_SELECT,
    });
    if (!reminder) throw new ResourceNotFoundException();
    return toReminder(reminder);
  }
}
