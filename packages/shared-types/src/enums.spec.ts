import {
  BILLING_METHODS,
  CLIENT_TYPES,
  FILE_STATUSES,
  FILE_TEAM_ROLES,
  FILE_TYPES,
  PARTY_TYPES,
} from './legal-file.js';
import { ACCOUNT_TYPES, JURISDICTIONS, OFFICE_LANGUAGES } from './office.js';
import { PRIORITIES } from './priority.js';

/** D-016: enum values are UPPER_SNAKE and unique; the backend checks they equal the Prisma enums. */
describe('enum value lists', () => {
  it.each(
    Object.entries({
      JURISDICTIONS,
      ACCOUNT_TYPES,
      OFFICE_LANGUAGES,
      PRIORITIES,
      FILE_TYPES,
      FILE_STATUSES,
      CLIENT_TYPES,
      FILE_TEAM_ROLES,
      PARTY_TYPES,
      BILLING_METHODS,
    }),
  )('%s should hold unique UPPER_SNAKE values', (_name, values) => {
    expect(values.length).toBeGreaterThan(0);
    expect(values.filter((value) => !/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(value))).toEqual([]);
    expect(new Set(values).size).toBe(values.length);
  });

  it('should include CRIMINAL among the file types (D-034)', () => {
    expect(FILE_TYPES).toContain('CRIMINAL');
  });
});
