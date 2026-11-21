import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { PinoLogger } from 'nestjs-pino';
import { Gauge } from 'prom-client';

import { MetricsService } from './metrics.service';
import { getQueue, QUEUE_NAMES } from '../common/queue/queues';
import { withTimeout } from '../common/queue/with-timeout';

export const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;
const SCRAPE_TIMEOUT_MS = 2000;

/**
 * `bullmq_queue_jobs{queue,state}` on /metrics, read from Redis at each scrape. The vendor agent's alert rules use it
 * (D-230: waiting > 100 for 10 min, any new failed reminder job, a spike of failed jobs). A queue Redis cannot answer
 * for is left out of that scrape instead of failing the whole endpoint.
 */
@Injectable()
export class QueueMetrics {
  readonly gauge: Gauge<'queue' | 'state'>;

  constructor(metrics: MetricsService, moduleRef: ModuleRef, logger: PinoLogger) {
    logger.setContext(QueueMetrics.name);
    // Unit tests replace QueueModule with QueueStubModule, which registers no queues: those are skipped.
    const queues = QUEUE_NAMES.flatMap((name): Queue[] => {
      try {
        return [getQueue(moduleRef, name)];
      } catch {
        return [];
      }
    });
    this.gauge = new Gauge({
      name: 'bullmq_queue_jobs',
      help: 'BullMQ jobs by queue and state',
      labelNames: ['queue', 'state'] as const,
      registers: [metrics.registry],
      async collect() {
        this.reset();
        await Promise.all(
          queues.map(async (queue) => {
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
}
