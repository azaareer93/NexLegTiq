import type { Request } from 'express';
import type { ClsService } from 'nestjs-cls';

import { CaseDocumentsController } from './case-documents.controller';
import type { DocumentRecordsService } from './document-records.service';
import { DocumentsController } from './documents.controller';
import type { DocumentsService } from './documents.service';
import type { RequestContext } from '../../common/context/request-context';

describe('DocumentsController', () => {
  it('should hand each route to its service with the caller', async () => {
    const service = {
      upload: jest.fn().mockResolvedValue('uploaded'),
      addVersion: jest.fn().mockResolvedValue('versioned'),
      versions: jest.fn().mockResolvedValue([]),
    };
    const records = {
      list: jest.fn().mockResolvedValue('page'),
      get: jest.fn().mockResolvedValue('document'),
      update: jest.fn().mockResolvedValue('updated'),
      remove: jest.fn().mockResolvedValue(undefined),
      download: jest.fn().mockResolvedValue('link'),
      text: jest.fn().mockResolvedValue('text'),
    };
    const req = { ip: '127.0.0.1', get: () => 'jest' } as unknown as Request;
    for (const active of [true, false]) {
      const cls = { isActive: () => active, getId: () => 'req-12345678' };
      const controller = new DocumentsController(
        service as unknown as DocumentsService,
        records as unknown as DocumentRecordsService,
        cls as unknown as ClsService<RequestContext>,
      );
      await expect(controller.upload(req, 'key-12345')).resolves.toBe('uploaded');
      await expect(controller.addVersion('d1', req)).resolves.toBe('versioned');
      await expect(controller.versions('d1')).resolves.toEqual([]);
      await expect(controller.get('d1')).resolves.toBe('document');
      await expect(controller.update('d1', { name: 'n' }, req)).resolves.toBe('updated');
      await controller.remove('d1', req);
      await expect(controller.download('d1', { version: 2 }, req)).resolves.toBe('link');
      await expect(controller.text('d1', { page: 1 }, req)).resolves.toBe('text');
    }
    expect(service.upload).toHaveBeenCalledWith(
      req,
      'key-12345',
      expect.objectContaining({ requestId: 'req-12345678' }),
    );
    expect(records.download).toHaveBeenLastCalledWith(
      'd1',
      2,
      expect.objectContaining({ requestId: null }),
    );
    const list = new CaseDocumentsController(records as unknown as DocumentRecordsService);
    await expect(list.list('f1', {} as never)).resolves.toBe('page');
  });
});
