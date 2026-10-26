import {
  base32Decode,
  base32Encode,
  newTotpSecret,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from './totp';

// RFC 6238 appendix B: the SHA-1 seed is the ASCII "12345678901234567890"; the RFC prints 8 digits, we use the last 6.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const RFC_VECTORS: readonly [number, string][] = [
  [59, '287082'],
  [1_111_111_109, '081804'],
  [1_111_111_111, '050471'],
  [1_234_567_890, '005924'],
  [2_000_000_000, '279037'],
  [20_000_000_000, '353130'],
];

describe('TOTP (D-145)', () => {
  it('should match the RFC 6238 SHA-1 test vectors', () => {
    for (const [seconds, code] of RFC_VECTORS) {
      expect(totpCode(RFC_SECRET, totpStep(new Date(seconds * 1000)))).toBe(code);
    }
  });

  it('should round-trip base32 and make 160-bit secrets', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw6ytboi======').toString()).toBe('foobar');
    expect(() => base32Decode('NOT-BASE32')).toThrow(RangeError);
    expect(base32Decode(newTotpSecret())).toHaveLength(20);
  });

  it('should accept the current and neighbouring steps once, never an older one or a reused one', () => {
    const now = new Date(1_234_567_890_000);
    const step = totpStep(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now, null)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now, null)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now, null)).toBeNull();
    // Already used (or older than the last accepted step): refused.
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now, step)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, '12345', now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', now, null)).toBeNull();
  });

  it('should build the otpauth URI authenticator apps scan', () => {
    const uri = new URL(otpauthUri('MZXW6YTBOI', 'admin@example.com'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/NexLegTiq Admin:admin@example.com');
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: 'MZXW6YTBOI',
      issuer: 'NexLegTiq Admin',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });
});
