import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from './prisma.service';
import type { ScopedPrismaClient } from './prisma.service';

/** A transaction opened on the scoped client. */
export type ScopedTransaction = Parameters<Parameters<ScopedPrismaClient['$transaction']>[0]>[0];
/** Registers work for after the commit; the label names it in the log if it fails (e.g. 'enqueue ocr'). */
export type AfterCommit = (task: () => Promise<unknown>, label?: string) => void;

/**
 * One transaction for a write, its timeline event and its audit row, plus work that must only happen once it has
 * committed — enqueueing jobs (.claude/rules/backend.md, D-084):
 *
 * ```ts
 * await this.uow.run(async (tx, afterCommit) => {
 *   const doc = await tx.document.create({ … });
 *   afterCommit(() => this.queues.enqueue(QUEUE.OCR, 'process-document', { documentId: doc.id }), 'enqueue ocr');
 * });
 * ```
 *
 * After-commit tasks run in order once the transaction has committed, and never when it rolls back. The data is already
 * committed then, so a failing task is logged, not thrown. Registering a task after the transaction has ended (from an
 * un-awaited callback) is a programming error and throws.
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
    const tasks: { task: () => Promise<unknown>; label: string }[] = [];
    let open = true;
    const afterCommit: AfterCommit = (task, label = 'after-commit task') => {
      if (!open) throw new Error(`afterCommit('${label}') called after the transaction ended`);
      tasks.push({ task, label });
    };
    let result: T;
    try {
      result = await this.prisma.db.$transaction((tx) => work(tx, afterCommit));
    } finally {
      open = false;
    }
    for (const { task, label } of tasks) {
      try {
        await task();
      } catch (error) {
        this.logger.error(
          { err: error, task: label },
          'After-commit task failed (the transaction is committed)',
        );
      }
    }
    return result;
  }
}
