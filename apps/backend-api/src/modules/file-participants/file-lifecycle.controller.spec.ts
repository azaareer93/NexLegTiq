import type { ClsService } from 'nestjs-cls';

import { FileLifecycleController } from './file-lifecycle.controller';
import type { FileLifecycleService } from './file-lifecycle.service';
import type { RequestContext } from '../../common/context/request-context';

const ID = '01920000-0000-7000-8000-000000000001';

/** The lifecycle routes only hand over to the service with the caller's request facts (D-153). */
describe('FileLifecycleController', () => {
  it('should pass every transition to the service', async () => {
    const lifecycle = {
      close: jest.fn(),
      reopen: jest.fn(),
      archive: jest.fn(),
      reassign: jest.fn().mockResolvedValue([]),
    };
    const cls = { isActive: () => true, getId: () => 'req-12345678' };
    const controller = new FileLifecycleController(
      lifecycle as unknown as FileLifecycleService,
      cls as unknown as ClsService<RequestContext>,
    );
    const req = { ip: '127.0.0.1', get: () => undefined } as never;
    await controller.close(ID, { force: false }, req);
    await controller.reopen(ID, req);
    await controller.archive(ID, req);
    await expect(controller.reassign(ID, { newResponsibleLawyerId: ID }, req)).resolves.toEqual([]);
    expect(lifecycle.close).toHaveBeenCalledWith(
      ID,
      { force: false },
      expect.objectContaining({ requestId: 'req-12345678' }),
    );
    expect(lifecycle.archive).toHaveBeenCalledWith(ID, expect.anything());
  });
});
