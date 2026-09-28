export const API_PREFIX = 'api/v1';

const DEFAULT_PORT = 3000;

/** Parses the PORT env var; falls back to 3000. Full env validation arrives with the Zod env schema (MVP-30/32). */
export function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: "${raw}"`);
  }
  return port;
}
