import { Injectable } from '@nestjs/common';

import { AI_COST_ALERT_JOB } from './ai-cost-alert';

export interface AiJobContext {
  readonly aiJobId: string;
  /** Who asked (the job's creator), for usage records. */
  readonly userId: string;
  readonly signal: AbortSignal;
}

/** Runs one kind of `ai` job and returns ids of what it produced (stored as the job's `result`). */
export type AiJobHandler = (
  data: Record<string, unknown>,
  context: AiJobContext,
) => Promise<Record<string, unknown>>;

/**
 * Handlers of the `ai` queue by job name (D-130). Feature modules register theirs on init in the worker; one processor
 * consumes the queue (BullMQ gives every job of a queue to its workers, D-085) and dispatches here.
 */
@Injectable()
export class AiJobRegistry {
  private readonly handlers = new Map<string, AiJobHandler>();

  register(type: string, handler: AiJobHandler): void {
    // The platform cost check runs under this name outside any office (D-144): no feature may use it.
    if (type === AI_COST_ALERT_JOB) throw new Error(`AI job type reserved: ${type}`);
    if (this.handlers.has(type)) throw new Error(`AI job handler already registered: ${type}`);
    this.handlers.set(type, handler);
  }

  get(type: string): AiJobHandler | undefined {
    return this.handlers.get(type);
  }
}
