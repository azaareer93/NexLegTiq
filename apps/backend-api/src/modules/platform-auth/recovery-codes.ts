import { randomBytes } from 'node:crypto';

import { base32Encode } from './totp';
import { hashOpaqueToken } from '../../common/auth/opaque-token';

export const RECOVERY_CODE_COUNT = 10;

/** `XXXXX-XXXXX`: 50 random bits in base32 (D-145). */
export function newRecoveryCode(): string {
  const text = base32Encode(randomBytes(7)).slice(0, 10);
  return `${text.slice(0, 5)}-${text.slice(5)}`;
}

/** What is stored and compared: case and dashes ignored, SHA-256 (high-entropy codes need no slow hash). */
export const recoveryCodeHash = (code: string): string =>
  hashOpaqueToken(code.replaceAll('-', '').toUpperCase());
