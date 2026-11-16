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
      invoices: jest.fn().mockResolvedValue([]),
      invoicePdf: jest.fn().mockResolvedValue({ status: 'READY' }),
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
      await expect(controller.invoices(req)).resolves.toEqual([]);
      const res = { status: jest.fn() };
      await expect(controller.invoicePdf('i1', req, res as never)).resolves.toEqual({
        status: 'READY',
      });
      expect(res.status).toHaveBeenCalledWith(200);
      portal.invoicePdf.mockResolvedValueOnce({ status: 'RENDERING' });
      await controller.invoicePdf('i1', req, res as never);
      expect(res.status).toHaveBeenLastCalledWith(202);
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
