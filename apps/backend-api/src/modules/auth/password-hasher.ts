import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

/** OWASP Password Storage Cheat Sheet, Argon2id minimum: m = 19 MiB, t = 2, p = 1 (D-082). */
// algorithm 2 = Algorithm.Argon2id (a const enum, not importable with isolatedModules).
const OPTIONS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Argon2id password hashing. The encoded hash carries its own parameters, so raising them later only affects new hashes. */
@Injectable()
export class PasswordHasher {
  // A real hash of a random secret: verifying unknown emails against it costs the same as a real check (no timing oracle).
  private readonly dummyHash = hash(randomBytes(32).toString('hex'), OPTIONS);

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  /** False for a wrong password and for any malformed or placeholder hash (e.g. the demo seed's `!`). */
  async verify(passwordHash: string | undefined, password: string): Promise<boolean> {
    if (passwordHash === undefined) {
      await verify(await this.dummyHash, password).catch(() => false);
      return false;
    }
    return verify(passwordHash, password).catch(() => false);
  }
}
