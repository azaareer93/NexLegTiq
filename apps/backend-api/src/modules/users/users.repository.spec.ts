import type { ClsService } from 'nestjs-cls';

import type { TeamService } from './team.service';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';

describe('users directory (D-123)', () => {
  it('should ask for active people by name and drop a row whose role the app does not know', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'a', fullName: 'Adel', role: 'LAWYER' },
      { id: 'b', fullName: 'Bad', role: 'CEO' },
    ]);
    const prisma = { db: { user: { findMany } } } as unknown as PrismaService;
    const controller = new UsersController(
      new UsersRepository(prisma),
      {} as TeamService,
      {} as ClsService<RequestContext>,
    );
    await expect(controller.directory()).resolves.toEqual([
      { id: 'a', fullName: 'Adel', role: 'LAWYER' },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true },
        select: { id: true, fullName: true, role: true },
      }),
    );
  });
});
