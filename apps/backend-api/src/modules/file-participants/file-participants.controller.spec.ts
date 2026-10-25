import type { Request } from 'express';
import type { ClsService } from 'nestjs-cls';

import type { FileClientsService } from './file-clients.service';
import { FileParticipantsController } from './file-participants.controller';
import type { FileTeamService } from './file-team.service';
import type { RequestContext } from '../../common/context/request-context';

describe('FileParticipantsController', () => {
  it('should hand each route to its service with the caller', async () => {
    const clients = {
      list: jest.fn().mockResolvedValue('clients'),
      add: jest.fn().mockResolvedValue('added'),
      makePrimary: jest.fn().mockResolvedValue('primary'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const team = {
      list: jest.fn().mockResolvedValue('team'),
      add: jest.fn().mockResolvedValue('joined'),
      changeRole: jest.fn().mockResolvedValue('changed'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const req = { ip: '127.0.0.1', get: () => 'jest' } as unknown as Request;
    for (const active of [true, false]) {
      const cls = { isActive: () => active, getId: () => 'req-12345678' };
      const controller = new FileParticipantsController(
        clients as unknown as FileClientsService,
        team as unknown as FileTeamService,
        cls as unknown as ClsService<RequestContext>,
      );
      await expect(controller.listClients('f1')).resolves.toBe('clients');
      await expect(controller.addClient('f1', { clientId: 'c1' }, req)).resolves.toBe('added');
      await expect(controller.makePrimary('f1', 'c1', { isPrimary: true }, req)).resolves.toBe(
        'primary',
      );
      await controller.removeClient('f1', 'c1', req);
      await expect(controller.listTeam('f1')).resolves.toBe('team');
      await expect(controller.addMember('f1', { userId: 'u1' }, req)).resolves.toBe('joined');
      await expect(controller.changeRole('f1', 'u1', { role: 'MEMBER' }, req)).resolves.toBe(
        'changed',
      );
      await controller.removeMember('f1', 'u1', req);
    }
    expect(team.changeRole).toHaveBeenCalledWith(
      'f1',
      'u1',
      'MEMBER',
      expect.objectContaining({ ip: '127.0.0.1' }),
    );
    expect(clients.add).toHaveBeenLastCalledWith(
      'f1',
      { clientId: 'c1' },
      expect.objectContaining({ requestId: null }),
    );
  });
});
