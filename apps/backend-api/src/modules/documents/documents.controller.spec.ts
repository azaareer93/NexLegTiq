import type { Request } from 'express';
import type { ClsService } from 'nestjs-cls';

import { DocumentsController } from './documents.controller';
import type { DocumentsService } from './documents.service';
import type { RequestContext } from '../../common/context/request-context';

describe('DocumentsController', () => {
  it('should hand each route to the service with the caller', async () => {
    const service = {
      upload: jest.fn().mockResolvedValue('uploaded'),
      addVersion: jest.fn().mockResolvedValue('versioned'),
      versions: jest.fn().mockResolvedValue([]),
    };
    const req = { ip: '127.0.0.1', get: () => 'jest' } as unknown as Request;
    for (const active of [true, false]) {
      const cls = { isActive: () => active, getId: () => 'req-12345678' };
      const controller = new DocumentsController(
        service as unknown as DocumentsService,
        cls as unknown as ClsService<RequestContext>,
      );
      await expect(controller.upload(req, 'key-12345')).resolves.toBe('uploaded');
      await expect(controller.addVersion('d1', req)).resolves.toBe('versioned');
      await expect(controller.versions('d1')).resolves.toEqual([]);
    }
    expect(service.upload).toHaveBeenCalledWith(
      req,
      'key-12345',
      expect.objectContaining({ requestId: 'req-12345678' }),
    );
    expect(service.upload).toHaveBeenLastCalledWith(
      req,
      'key-12345',
      expect.objectContaining({ requestId: null }),
    );
  });
});
