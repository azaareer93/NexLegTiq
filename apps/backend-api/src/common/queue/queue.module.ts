import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PinoLogger } from 'nestjs-pino';

import { AppConfig } from '../../config/app-config';
import { ReadinessRegistry } from '../../health/readiness.registry';
import { QueueProducer } from './queue-producer';
import { getQueue, QUEUE, QUEUE_NAMES, QUEUE_POLICY } from './queues';
import { redisConnectionOptions } from './redis-connection';

/**
 * BullMQ (D-011, D-084): the Redis connection and key prefix from env, every canonical queue with its default job
 * options, and the producer. Imported by both processes; processors are registered only by the worker process
 * (`src/worker.ts`), so the HTTP app never consumes jobs. Registers the `redis` readiness check.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        connection: redisConnectionOptions(config.redis.url),
        prefix: config.redis.bullmqPrefix,
      }),
    }),
    BullModule.registerQueue(...QUEUE_NAMES.map((name) => ({ name, defaultJobOptions: QUEUE_POLICY[name].jobs }))),
  ],
  providers: [QueueProducer],
  exports: [BullModule, QueueProducer],
})
export class QueueModule implements OnModuleInit {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly readiness: ReadinessRegistry,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(QueueModule.name);
  }

  onModuleInit(): void {
    const queues = QUEUE_NAMES.map((name) => getQueue(this.moduleRef, name));
    // An 'error' event without a listener crashes the process: a Redis outage must degrade (503 on /health/ready, failed
    // enqueues) instead. ioredis reconnects on its own.
    for (const queue of queues) queue.on('error', (error) => this.logger.warn({ err: error, queue: queue.name }, 'Queue connection error'));
    // Every queue shares the same Redis: one PING through any queue's connection covers them all.
    const probe = getQueue(this.moduleRef, QUEUE.NOTIFICATION);
    this.readiness.register('redis', async () => {
      await (await probe.client).runCommand('ping', []);
    });
  }
}
