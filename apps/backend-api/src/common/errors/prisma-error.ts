/** Prisma error classes, matched by name so this module does not depend on the generated client. */
const PRISMA_ERROR_NAMES = new Set([
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientRustPanicError',
  'PrismaClientInitializationError',
  'PrismaClientValidationError',
]);

export type PrismaErrorCode = 'RES-001' | 'RES-002' | 'RES-003' | 'DB-001';

const KNOWN_CODE_MAP: Readonly<Record<string, PrismaErrorCode>> = {
  P2002: 'RES-002', // unique constraint
  P2025: 'RES-001', // record not found
  P2034: 'RES-003', // write conflict / deadlock
};

export function isPrismaError(error: unknown): error is Error & { code?: unknown } {
  return error instanceof Error && PRISMA_ERROR_NAMES.has(error.name);
}

/** api-conventions.md: P2002 → RES-002, P2025 → RES-001, P2034 → RES-003, anything else → DB-001. */
export function mapPrismaError(error: Error & { code?: unknown }): PrismaErrorCode {
  const mapped = typeof error.code === 'string' ? KNOWN_CODE_MAP[error.code] : undefined;
  return mapped ?? 'DB-001';
}
