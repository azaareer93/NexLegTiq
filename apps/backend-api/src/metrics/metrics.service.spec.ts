import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { MetricsService } from './metrics.service';

function exchange(
  req: Partial<IncomingMessage> & { baseUrl?: string; route?: { path?: unknown } },
  statusCode: number,
) {
  const res = Object.assign(new EventEmitter(), { statusCode }) as unknown as ServerResponse;
  return { req: req as IncomingMessage, res };
}

describe('MetricsService', () => {
  it('should label a matched request with its route template and status', async () => {
    const metrics = new MetricsService();
    const { req, res } = exchange(
      { method: 'GET', baseUrl: '/api/v1', route: { path: '/cases/:id' } },
      200,
    );
    const next = jest.fn();

    metrics.middleware(req, res, next);
    res.emit('close');

    expect(next).toHaveBeenCalled();
    expect(await metrics.render()).toContain(
      'method="GET",route="/api/v1/cases/:id",status_code="200"',
    );
  });

  it('should label unmatched requests as "unmatched" to bound cardinality', async () => {
    const metrics = new MetricsService();
    const { req, res } = exchange({ method: 'POST' }, 404);

    metrics.middleware(req, res, () => undefined);
    res.emit('close');

    expect(await metrics.render()).toContain('route="unmatched",status_code="404"');
  });
});
