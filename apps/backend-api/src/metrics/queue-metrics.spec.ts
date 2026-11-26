import type { ModuleRef } from '@nestjs/core';
import type { PinoLogger } from 'nestjs-pino';

import { MetricsService } from './metrics.service';
import { QueueMetrics } from './queue-metrics';

const logger = () =>
  ({ setContext: jest.fn(), warn: jest.fn() }) as unknown as PinoLogger & { warn: jest.Mock };

function setup(getJobCounts: (name: string) => Promise<Record<string, number>>) {
  const moduleRef = {
    get: (token: string) => {
      const name = token.replace(/^BullQueue_/, '');
      if (name === 'batch-ingest') throw new Error('not registered');
      return { name, getJobCounts: () => getJobCounts(name) };
    },
  } as unknown as ModuleRef;
  const metrics = new MetricsService();
  const log = logger();
  new QueueMetrics(metrics, moduleRef, log);
  return { metrics, log };
}

describe('QueueMetrics', () => {
  it('should expose job counts per queue and state', async () => {
    const { metrics } = setup((name) =>
      Promise.resolve({ waiting: name === 'reminder' ? 120 : 0, active: 1, delayed: 0, failed: 2 }),
    );

    const output = await metrics.render();

    expect(output).toContain('bullmq_queue_jobs{queue="reminder",state="waiting"} 120');
    expect(output).toContain('bullmq_queue_jobs{queue="email",state="failed"} 2');
    expect(output).not.toContain('queue="batch-ingest"');
  });

  it('should leave out a queue Redis cannot answer for instead of failing the scrape', async () => {
    const { metrics, log } = setup((name) =>
      name === 'ocr'
        ? Promise.reject(new Error('ECONNREFUSED'))
        : Promise.resolve({ waiting: 0, active: 0, delayed: 0, failed: 0 }),
    );

    const output = await metrics.render();

    expect(output).toContain('queue="email",state="waiting"');
    expect(output).not.toContain('queue="ocr"');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'ocr' }),
      'Queue metrics unavailable',
    );
  });
});
