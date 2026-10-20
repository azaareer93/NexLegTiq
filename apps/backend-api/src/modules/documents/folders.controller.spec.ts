import type { Request } from 'express';
import type { ClsService } from 'nestjs-cls';

import { FoldersController } from './folders.controller';
import type { FoldersService } from './folders.service';
import type { RequestContext } from '../../common/context/request-context';

describe('FoldersController', () => {
  it('should hand each route to the service with the caller', async () => {
    const service = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue('created'),
      update: jest.fn().mockResolvedValue('updated'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const req = { ip: '127.0.0.1', get: () => 'jest' } as unknown as Request;
    for (const active of [true, false]) {
      const cls = { isActive: () => active, getId: () => 'req-12345678' };
      const controller = new FoldersController(
        service as unknown as FoldersService,
        cls as unknown as ClsService<RequestContext>,
      );
      await expect(controller.list('f1')).resolves.toEqual([]);
      await expect(controller.create('f1', { name: 'Drafts' }, req)).resolves.toBe('created');
      await expect(controller.update('f1', 'd1', { name: 'Old' }, req)).resolves.toBe('updated');
      await controller.remove('f1', 'd1', req);
    }
    expect(service.create).toHaveBeenCalledWith(
      'f1',
      { name: 'Drafts' },
      expect.objectContaining({ requestId: 'req-12345678' }),
    );
    expect(service.remove).toHaveBeenLastCalledWith(
      'f1',
      'd1',
      expect.objectContaining({ requestId: null }),
    );
  });
});
