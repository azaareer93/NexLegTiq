/**
 * Programming errors of the tenant layer (D-018). They surface as 500 SYS-001 through the global filter: a request never
 * legitimately reaches them, so they must be loud in tests and logs rather than mapped to a client error.
 */
export class TenantContextMissingError extends Error {
  override readonly name = 'TenantContextMissingError';

  constructor(target: string) {
    super(`No officeId in the request context for ${target}; wrap background work in TenantRunner.run()`);
  }
}

/** A query tried to read or write outside the current office, or used a shape the tenant layer cannot scope. */
export class TenantViolationError extends Error {
  override readonly name = 'TenantViolationError';
}
