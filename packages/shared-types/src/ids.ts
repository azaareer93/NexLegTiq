import type { Brand } from './brand.js';

/** UUID v7 identifiers (D-015). Brand values at the boundary (contracts/repositories), never with casts in logic. */
export type OfficeId = Brand<string, 'OfficeId'>;
export type UserId = Brand<string, 'UserId'>;
