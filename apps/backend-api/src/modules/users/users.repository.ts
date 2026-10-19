import { Injectable } from '@nestjs/common';
import type { DirectoryUser } from '@nexlegtiq/shared-contracts';
import { isRole } from '@nexlegtiq/shared-types';

import { PrismaService } from '../../database/prisma.service';

/** shortcut: no paging — offices have tens of users (plans cap at 10 or so); page it if an office ever passes 500. */
const MAX_USERS = 500;

@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async directory(): Promise<DirectoryUser[]> {
    const users = await this.prisma.db.user.findMany({
      where: { isActive: true },
      select: { id: true, fullName: true, role: true },
      orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
      take: MAX_USERS,
    });
    return users.filter((user): user is DirectoryUser => isRole(user.role));
  }
}
