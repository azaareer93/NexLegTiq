import { uuidV7 } from './uuid-v7';

describe('uuidV7', () => {
  it('should be a version-7 RFC 9562 UUID carrying the time, ordered by it', () => {
    const id = uuidV7(0x0192_0000_0000);
    expect(id).toMatch(/^01920000-0000-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidV7(1) < uuidV7(2)).toBe(true);
    expect(uuidV7()).not.toBe(uuidV7());
  });
});
