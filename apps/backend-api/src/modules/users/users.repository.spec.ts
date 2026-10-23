import type { Request } from 'express';
import type { ClsService } from 'nestjs-cls';

import type { InvitationsService } from './invitations.service';
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
      {} as InvitationsService,
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

describe('users controller → team service (D-124)', () => {
  it('should pass ids, bodies and the caller to the team service', async () => {
    const team = {
      list: jest.fn().mockResolvedValue([]),
      openFiles: jest.fn().mockResolvedValue([]),
      changeRole: jest.fn().mockResolvedValue({}),
      deactivate: jest.fn().mockResolvedValue({}),
      reactivate: jest.fn().mockResolvedValue({}),
    };
    const cls = { isActive: () => false } as unknown as ClsService<RequestContext>;
    const controller = new UsersController(
      {} as UsersRepository,
      team as unknown as TeamService,
      {} as InvitationsService,
      cls,
    );
    const req = { ip: '127.0.0.1', headers: {}, get: () => undefined } as unknown as Request;
    await controller.list();
    await controller.openFiles('u1');
    await controller.changeRole('u1', { role: 'LAWYER' }, req);
    await controller.deactivate('u1', { reassignments: [] }, req);
    await controller.reactivate('u1', req);
    expect(team.openFiles).toHaveBeenCalledWith('u1');
    expect(team.changeRole).toHaveBeenCalledWith('u1', 'LAWYER', expect.any(Object));
    expect(team.deactivate).toHaveBeenCalledWith('u1', { reassignments: [] }, expect.any(Object));
    expect(team.reactivate).toHaveBeenCalledWith('u1', expect.any(Object));
  });
});
