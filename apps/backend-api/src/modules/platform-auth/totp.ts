import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD_SECONDS = 30;
const DIGITS = 6;
/** Codes from one step before or after are accepted: a phone clock off by up to 30 s still works. */
const WINDOW = 1;

/** RFC 4648 base32 without padding — what authenticator apps read. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new RangeError('Not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new shared secret: 20 random bytes (160 bits, RFC 4226's recommendation), base32. */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export const totpStep = (now: Date): number =>
  Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);

/** The 6-digit code of a time step (RFC 6238 with HMAC-SHA1, as every authenticator app uses by default). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * The step a code belongs to when it is valid now (±1 step) and newer than `lastStep` — a code already used, or an
 * older one, is refused, so a code seen over a shoulder cannot be replayed. Null otherwise.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now: Date,
  lastStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(now);
  for (let step = current - WINDOW; step <= current + WINDOW; step += 1) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(totpCode(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

/** The `otpauth://` URI an authenticator app scans as a QR code (the app draws it; the secret never leaves this answer). */
export function otpauthUri(secret: string, email: string): string {
  const label = encodeURIComponent(`NexLegTiq Admin:${email}`);
  const params = new URLSearchParams({
    secret,
    issuer: 'NexLegTiq Admin',
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
