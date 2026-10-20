/**
 * Per-provider circuit breaker (D-130): after `threshold` availability failures in a row the provider is skipped for
 * `coolDownMs`; then one trial call is let through (half-open) — a success closes it, a failure opens it again. Per
 * process: each API or worker instance learns on its own, which is enough to stop hammering a provider that is down.
 */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private trialRunning = false;

  constructor(
    private readonly threshold = 5,
    private readonly coolDownMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** May a call go out now? Claims the single half-open trial when the cool-down is over. */
  allow(): boolean {
    if (this.failures < this.threshold) return true;
    if (this.now() < this.openUntil || this.trialRunning) return false;
    this.trialRunning = true;
    return true;
  }

  succeeded(): void {
    this.failures = 0;
    this.trialRunning = false;
  }

  failed(): void {
    this.failures += 1;
    this.trialRunning = false;
    if (this.failures >= this.threshold) this.openUntil = this.now() + this.coolDownMs;
  }
}
