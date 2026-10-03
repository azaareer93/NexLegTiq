import { getQueueToken } from '@nestjs/bullmq';
import type { DefaultJobOptions, Queue } from 'bullmq';

/** Canonical queue names (D-011, architecture.md#queues). Keys are code constants; values are the BullMQ queue names. */
export const QUEUE = {
  OCR: 'ocr',
  AI: 'ai',
  REMINDER: 'reminder',
  EMAIL: 'email',
  NOTIFICATION: 'notification',
  REPORT: 'report',
  BATCH_INGEST: 'batch-ingest',
} as const;
export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];
export const QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUE);

const DAY_SECONDS = 86_400;

interface QueuePolicy {
  /** Retry, backoff and retention applied to every job added to the queue. */
  readonly jobs: DefaultJobOptions;
  /** A job running longer than this fails and is retried per `attempts` (BullMQ has no job timeout of its own). */
  readonly timeoutMs: number;
  /** Jobs processed in parallel per worker process: architecture.md's priority (high 10, medium 5, low 2). */
  readonly concurrency: number;
}

/** Retention for every queue (architecture.md): completed jobs for 7 days or the last 1000, failed jobs for 30 days. */
const RETENTION: DefaultJobOptions = {
  removeOnComplete: { age: 7 * DAY_SECONDS, count: 1000 },
  removeOnFail: { age: 30 * DAY_SECONDS },
};

const policy = (jobs: DefaultJobOptions, timeoutMs: number, concurrency: number): QueuePolicy => ({
  jobs: { ...RETENTION, ...jobs },
  timeoutMs,
  concurrency,
});

/** Per-queue defaults from the architecture.md queue table. */
export const QUEUE_POLICY: Readonly<Record<QueueName, QueuePolicy>> = {
  ocr: policy({ attempts: 3, backoff: { type: 'exponential', delay: 1000 } }, 60_000, 10),
  ai: policy({ attempts: 2, backoff: { type: 'fixed', delay: 10_000 } }, 120_000, 5),
  reminder: policy({ attempts: 3, backoff: { type: 'exponential', delay: 1000 } }, 30_000, 10),
  email: policy({ attempts: 3, backoff: { type: 'fixed', delay: 5000 } }, 30_000, 2),
  notification: policy({ attempts: 3, backoff: { type: 'exponential', delay: 1000 } }, 30_000, 10),
  report: policy({ attempts: 2, backoff: { type: 'exponential', delay: 1000 } }, 120_000, 2),
  // Phase 2 (email/voice ingest): no retries until its jobs are designed.
  'batch-ingest': policy({ attempts: 1 }, 120_000, 5),
};

/** Worker options for `@Processor(name, workerOptions(name))`. */
export function workerOptions(name: QueueName): { concurrency: number } {
  return { concurrency: QUEUE_POLICY[name].concurrency };
}

/** Anything that resolves providers: an application context or a ModuleRef. */
interface ProviderSource {
  get(token: string, options: { strict: false }): unknown;
}

/** The BullMQ queue registered under a canonical name (QueueModule, Bull Board, tests). */
export function getQueue(source: ProviderSource, name: QueueName): Queue {
  return source.get(getQueueToken(name), { strict: false }) as Queue;
}
