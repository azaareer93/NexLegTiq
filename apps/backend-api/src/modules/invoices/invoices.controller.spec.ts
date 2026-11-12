import type { InvoiceLifecycle } from './invoice-lifecycle.service';
import { InvoicesController } from './invoices.controller';
import type { InvoicesService } from './invoices.service';

const ID = '01920000-0000-7000-8000-000000000001';

/** The controller only hands over to the services (D-162): every route reaches its method with its input. */
describe('InvoicesController', () => {
  it('should pass each route to its service', async () => {
    const invoices = {
      list: jest.fn().mockResolvedValue('list'),
      create: jest.fn().mockResolvedValue('created'),
      get: jest.fn().mockResolvedValue('invoice'),
    };
    const lifecycle = {
      update: jest.fn().mockResolvedValue('updated'),
      remove: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue('sent'),
      markPaid: jest.fn().mockResolvedValue('paid'),
      void: jest.fn().mockResolvedValue('voided'),
    };
    const controller = new InvoicesController(
      invoices as unknown as InvoicesService,
      lifecycle as unknown as InvoiceLifecycle,
    );
    await expect(controller.list({ page: 1, limit: 20 } as never)).resolves.toBe('list');
    await expect(controller.create({ clientId: ID } as never)).resolves.toBe('created');
    await expect(controller.get(ID)).resolves.toBe('invoice');
    await expect(controller.update(ID, { notes: 'x' })).resolves.toBe('updated');
    await controller.remove(ID);
    await expect(controller.send(ID)).resolves.toBe('sent');
    await expect(
      controller.markPaid(ID, { paidAt: '2026-11-10T09:00:00Z', method: 'CASH' }),
    ).resolves.toBe('paid');
    await expect(controller.void(ID)).resolves.toBe('voided');
    expect(lifecycle.remove).toHaveBeenCalledWith(ID);
  });
});
