import type { Request } from 'express';
import type { ClsService } from 'nestjs-cls';

import { PortalController } from './portal.controller';
import type { PortalService } from './portal.service';
import type { RequestContext } from '../../common/context/request-context';

describe('PortalController', () => {
  it('should pass the signed-in account to every route', async () => {
    const portal = {
      files: jest.fn().mockResolvedValue([]),
      file: jest.fn().mockResolvedValue('file'),
      documents: jest.fn().mockResolvedValue([]),
      download: jest.fn().mockResolvedValue('link'),
      upload: jest.fn().mockResolvedValue('upload'),
      uploads: jest.fn().mockResolvedValue([]),
    };
    const req = { clientUserId: 'u1', ip: '127.0.0.1', get: () => 'jest' } as unknown as Request;
    for (const active of [true, false]) {
      const controller = new PortalController(
        portal as unknown as PortalService,
        { isActive: () => active, getId: () => 'req-1' } as unknown as ClsService<RequestContext>,
      );
      await expect(controller.files(req)).resolves.toEqual([]);
      await expect(controller.file('f1', req)).resolves.toBe('file');
      await expect(controller.documents('f1', req)).resolves.toEqual([]);
      await expect(controller.download('d1', req)).resolves.toBe('link');
      await expect(controller.upload('f1', req)).resolves.toBe('upload');
      await expect(controller.uploads('f1', req)).resolves.toEqual([]);
    }
    expect(portal.file).toHaveBeenCalledWith('u1', 'f1');
    expect(portal.download).toHaveBeenLastCalledWith(
      'u1',
      'd1',
      expect.objectContaining({ requestId: null }),
    );
    const controller = new PortalController(
      portal as unknown as PortalService,
      {} as ClsService<RequestContext>,
    );
    expect(() => controller.files({} as Request)).toThrow('PortalAuthGuard did not run');
  });
});
