/** Court types (D-037). Mirrors the Prisma enum; labels: `enums.courtType.<VALUE>`. */
export const COURT_TYPES = [
  'CIVIL',
  'CRIMINAL',
  'COMMERCIAL',
  'LABOR',
  'FAMILY',
  'ADMINISTRATIVE',
  'SHARIA',
  'MAGISTRATE',
  'FIRST_INSTANCE',
  'APPEAL',
  'CASSATION',
  'SUPREME',
  'ARBITRATION',
] as const;
export type CourtType = (typeof COURT_TYPES)[number];
