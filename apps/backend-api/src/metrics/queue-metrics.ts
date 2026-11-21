import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { Gauge } from 'prom-client';

import { MetricsService } from './metrics.service';
import { getQueue, QUEUE_NAMES } from '../common/queue/queues';
import { withTimeout } from '../common/queue/with-timeout';

// `prioritized`: jobs enqueued with a priority wait there instead of in `waiting`.
export const QUEUE_STATES = ['waiting', 'prioritized', 'active', 'delayed', 'failed'] as const;
const SCRAPE_TIMEOUT_MS = 2000;

/**
 * `bullmq_queue_jobs{queue,state}` on /metrics, read from Redis at each scrape, for the vendor's alert rules (D-230:
 * a backed-up queue, a stalled worker). A queue Redis cannot answer for is left out of that scrape instead of failing
 * the whole endpoint.
 */
@Injectable()
export class QueueMetrics {
  readonly gauge: Gauge<'queue' | 'state'>;
  private queues: Queue[] | undefined;

  constructor(
    metrics: MetricsService,
    private readonly moduleRef: ModuleRef,
    logger: PinoLogger,
  ) {
    logger.setContext(QueueMetrics.name);
    const queuesOf = (): Queue[] => (this.queues ??= this.resolveQueues());
    this.gauge = new Gauge({
      name: 'bullmq_queue_jobs',
      help: 'BullMQ jobs by queue and state',
      labelNames: ['queue', 'state'] as const,
      registers: [metrics.registry],
      async collect() {
        this.reset();
        await Promise.all(
          queuesOf().map(async (queue) => {
            try {
              // ioredis queues commands while Redis is down; a scrape must not hang on them.
              const counts = await withTimeout(
                () => queue.getJobCounts(...QUEUE_STATES),
                SCRAPE_TIMEOUT_MS,
              );
              for (const state of QUEUE_STATES) {
                this.set({ queue: queue.name, state }, counts[state] ?? 0);
              }
            } catch (error) {
              logger.warn({ err: error, queue: queue.name }, 'Queue metrics unavailable');
            }
          }),
        );
      },
    });
  }

  /** Resolved at the first scrape, once every provider is built. Unit tests' QueueStubModule registers none. */
  private resolveQueues(): Queue[] {
    return QUEUE_NAMES.flatMap((name): Queue[] => {
      try {
        const queue = getQueue(this.moduleRef, name) as Queue | undefined;
        return queue ? [queue] : [];
      } catch {
        return [];
      }
    });
  }
}
