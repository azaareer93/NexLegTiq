import { LocaleSchema } from '@nexlegtiq/shared-contracts';
import { isLocale } from '@nexlegtiq/shared-types';

// Guards the workspace wiring: backend-api must resolve its allowed shared packages (and their deps, e.g. zod).
describe('workspace packages', () => {
  it('should resolve shared-types', () => {
    expect(isLocale('ar')).toBe(true);
  });

  it('should resolve shared-contracts with its zod dependency', () => {
    expect(LocaleSchema.safeParse('en').success).toBe(true);
  });
});
