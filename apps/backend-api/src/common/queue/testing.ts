import { Global, Module } from '@nestjs/common';
import type { Queue } from 'bullmq';

import { QueueProducer } from './queue-producer';

export { getQueue } from './queues';

/**
 * Test-only stand-in for QueueModule in unit tests that build the app without Redis
 * (`.overrideModule(QueueModule).useModule(QueueStubModule)`): no connections, no `redis` readiness check, and a
 * producer that refuses to enqueue.
 */
@Global()
@Module({
  providers: [
    {
      provide: QueueProducer,
      useValue: { enqueue: () => Promise.reject(new Error('No queues in unit tests')) },
    },
  ],
  exports: [QueueProducer],
})
export class QueueStubModule {}

const PENDING_STATES = [
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
  'paused',
] as const;

/**
 * Test-only: resolves once the queue has no pending work (waiting, active, delayed or retrying jobs), so a test can assert
 * on the outcome. Integration tests run against real Redis — BullMQ relies on Lua scripts that in-memory fakes do not run
 * (D-084).
 */
export async function drainQueue(queue: Queue, timeoutMs = 10_000, pollMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const counts = await queue.getJobCounts(...PENDING_STATES);
    if (Object.values(counts).every((count) => count === 0)) return;
    if (Date.now() >= deadline)
      throw new Error(
        `Queue ${queue.name} still has pending jobs after ${timeoutMs} ms: ${JSON.stringify(counts)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
