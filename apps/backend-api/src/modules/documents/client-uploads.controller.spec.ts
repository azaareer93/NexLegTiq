import type { Request } from 'express';
import type { ClsService } from 'nestjs-cls';

import { CaseClientUploadsController, ClientUploadsController } from './client-uploads.controller';
import type { ClientUploadsService } from './client-uploads.service';
import type { RequestContext } from '../../common/context/request-context';

describe('client uploads controllers', () => {
  it('should hand each route to the service with the caller', async () => {
    const service = {
      list: jest.fn().mockResolvedValue([]),
      download: jest.fn().mockResolvedValue('link'),
      accept: jest.fn().mockResolvedValue('accepted'),
      reject: jest.fn().mockResolvedValue('rejected'),
    };
    const req = { ip: '127.0.0.1', get: () => 'jest' } as unknown as Request;
    await expect(
      new CaseClientUploadsController(service as unknown as ClientUploadsService).list('f1'),
    ).resolves.toEqual([]);
    for (const active of [true, false]) {
      const controller = new ClientUploadsController(
        service as unknown as ClientUploadsService,
        { isActive: () => active, getId: () => 'req-1' } as unknown as ClsService<RequestContext>,
      );
      await expect(controller.download('u1', req)).resolves.toBe('link');
      await expect(controller.accept('u1', { documentType: 'OTHER' }, req)).resolves.toBe(
        'accepted',
      );
      await expect(controller.reject('u1', { reason: 'x' }, req)).resolves.toBe('rejected');
    }
    expect(service.reject).toHaveBeenLastCalledWith(
      'u1',
      { reason: 'x' },
      expect.objectContaining({ requestId: null }),
    );
  });
});
