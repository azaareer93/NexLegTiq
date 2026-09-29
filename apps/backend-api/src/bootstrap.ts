export const API_PREFIX = 'api/v1';

const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

interface SignalSource {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

/**
 * Resolves with the first SIGTERM/SIGINT. Holds a timer so the event loop stays alive while the worker has no
 * other handles (no queue processors are registered until MVP-34).
 */
export function waitForShutdownSignal(source: SignalSource = process): Promise<ShutdownSignal> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => undefined, 2 ** 30);
    const listeners = SHUTDOWN_SIGNALS.map((signal) => {
      const listener = (): void => {
        clearInterval(keepAlive);
        for (const [other, fn] of listeners) source.off(other, fn);
        resolve(signal);
      };
      return [signal, listener] as const;
    });
    for (const [signal, listener] of listeners) source.once(signal, listener);
  });
}
