import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from './prisma.service';
import type { ScopedPrismaClient } from './prisma.service';

/** A transaction opened on the scoped client. */
export type ScopedTransaction = Parameters<Parameters<ScopedPrismaClient['$transaction']>[0]>[0];
export type AfterCommit = (task: () => Promise<unknown>) => void;

/**
 * One transaction for a write, its timeline event and its audit row, plus work that must only happen once it has
 * committed — enqueueing jobs (.claude/rules/backend.md, D-084):
 *
 * ```ts
 * await this.uow.run(async (tx, afterCommit) => {
 *   const doc = await tx.document.create({ … });
 *   afterCommit(() => this.queues.enqueue(QUEUE.OCR, 'process-document', { documentId: doc.id }));
 * });
 * ```
 *
 * After-commit tasks run in order once the transaction has committed, and never when it rolls back. The data is already
 * committed then, so a failing task is logged, not thrown.
 * ponytail: a lost enqueue leaves e.g. a document in PROCESSING until its retry endpoint is used; move to a
 * transactional outbox if lost jobs ever matter more than that.
 */
@Injectable()
export class UnitOfWork {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(UnitOfWork.name);
  }

  async run<T>(work: (tx: ScopedTransaction, afterCommit: AfterCommit) => Promise<T>): Promise<T> {
    const tasks: (() => Promise<unknown>)[] = [];
    const result = await this.prisma.db.$transaction((tx) => work(tx, (task) => void tasks.push(task)));
    for (const task of tasks) {
      try {
        await task();
      } catch (error) {
        this.logger.error({ err: error }, 'After-commit task failed (the transaction is committed)');
      }
    }
    return result;
  }
}
