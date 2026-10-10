import type { Permission } from '@nexlegtiq/shared-types';

/**
 * The RBAC matrix has no court permission (D-115): reading courts, judges and prosecutors follows seeing files (every
 * role), adding the office's own follows opening files or scheduling hearings (OM, SL, L, P).
 */
export const READ_REFERENCE = [
  'view:all:cases',
  'view:assigned:cases',
] as const satisfies readonly Permission[];
export const WRITE_REFERENCE = [
  'create:case',
  'create:session',
] as const satisfies readonly Permission[];
