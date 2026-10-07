/**
 * Runs `work` with a signal that aborts after `ms`; the call rejects at that moment whether or not `work` listens.
 * Used for job attempts (TenantProcessor) and for enqueueing while Redis may be unreachable (QueueProducer).
 */
export async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Timed out after ${ms} ms`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
