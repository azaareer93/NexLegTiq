export const API_PREFIX = 'api/v1';

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = 'localhost';
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/** Parses the PORT env var; falls back to 3000. Full env validation arrives with the Zod env schema (MVP-30/32). */
export function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: "${raw}"`);
  }
  return port;
}

/** Bind address. Defaults to localhost so dev/e2e runs are not exposed on the LAN; containers set HOST=0.0.0.0. */
export function resolveHost(raw: string | undefined): string {
  const host = raw?.trim();
  return host ? host : DEFAULT_HOST;
}

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
