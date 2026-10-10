import { FieldCipher } from './field-cipher';
import { AppConfig } from '../../config/app-config';
import { testEnv } from '../../config/env.fixture';
import { parseEnv } from '../../config/env.schema';

const cipherWith = (key?: string) =>
  new FieldCipher(new AppConfig(parseEnv(testEnv(key ? { ENCRYPTION_KEY: key } : {}))));

describe('FieldCipher', () => {
  const cipher = cipherWith();
  const context = 'clients.national_id:office-a';

  it('should round-trip Arabic and Latin text with a v1 prefix the database CHECK accepts', () => {
    for (const plain of ['401234567', 'رقم ٤٠١٢٣٤٥٦٧', '']) {
      const stored = cipher.encrypt(plain, context);
      expect(stored).toMatch(/^v[0-9]+:/);
      expect(stored).not.toContain(plain || '\u0000');
      expect(cipher.decrypt(stored, context)).toBe(plain);
    }
  });

  it('should use a fresh IV, so equal values do not look equal', () => {
    expect(cipher.encrypt('401234567', context)).not.toBe(cipher.encrypt('401234567', context));
  });

  it('should refuse another context, another key, tampered data and unknown formats', () => {
    const stored = cipher.encrypt('401234567', context);
    expect(() => cipher.decrypt(stored, 'clients.national_id:office-b')).toThrow();
    expect(() => cipherWith('f'.repeat(63) + 'e').decrypt(stored, context)).toThrow();
    const payload = Buffer.from(stored.slice(3), 'base64url');
    payload[payload.length - 1] = (payload[payload.length - 1] ?? 0) ^ 1;
    expect(() => cipher.decrypt(`v1:${payload.toString('base64url')}`, context)).toThrow();
    for (const bad of ['v2:abc', '401234567', 'v1:', 'v1:a:b']) {
      expect(() => cipher.decrypt(bad, context)).toThrow('Unsupported ciphertext format');
    }
  });
});
