import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

export type ReadinessCheck = () => Promise<void>;

export interface ReadinessReport {
  readonly status: 'ok' | 'error';
  readonly checks: Readonly<Record<string, { readonly status: 'up' | 'down'; readonly durationMs: number }>>;
}

export const READINESS_TIMEOUT_MS = 3000;

/**
 * Dependencies register a readiness check here (`onModuleInit`): Prisma/db (MVP-33), Redis (MVP-34), object storage
 * (MVP-35). A check resolves when healthy and rejects (or times out) otherwise. Failure reasons are logged, never
 * returned — `/health/ready` is reachable by uptime monitors.
 */
@Injectable()
export class ReadinessRegistry {
  private readonly checks = new Map<string, ReadinessCheck>();

  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(ReadinessRegistry.name);
  }

  register(name: string, check: ReadinessCheck): void {
    if (this.checks.has(name)) throw new Error(`Readiness check "${name}" is already registered`);
    this.checks.set(name, check);
  }

  names(): string[] {
    return [...this.checks.keys()];
  }

  async run(timeoutMs = READINESS_TIMEOUT_MS): Promise<ReadinessReport> {
    const entries = await Promise.all(
      [...this.checks].map(async ([name, check]) => [name, await this.runOne(name, check, timeoutMs)] as const),
    );
    const checks = Object.fromEntries(entries);
    const status = entries.every(([, result]) => result.status === 'up') ? 'ok' : 'error';
    return { status, checks };
  }

  private async runOne(
    name: string,
    check: ReadinessCheck,
    timeoutMs: number,
  ): Promise<{ status: 'up' | 'down'; durationMs: number }> {
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        check(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
      return { status: 'up', durationMs: Math.round(performance.now() - started) };
    } catch (error) {
      this.logger.warn({ err: error, check: name }, 'Readiness check failed');
      return { status: 'down', durationMs: Math.round(performance.now() - started) };
    } finally {
      clearTimeout(timer);
    }
  }
}
