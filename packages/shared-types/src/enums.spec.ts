import { COURT_TYPES } from './court.js';
import {
  DOCUMENT_LANGUAGES,
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  FOLDER_SYSTEM_KEYS,
  OCR_STATUSES,
} from './document.js';
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
import { REMINDER_STATUSES, SESSION_OUTCOMES, SESSION_STATUSES, SESSION_TYPES } from './session.js';
import { SUBSCRIPTION_STATUSES } from './subscription.js';
import { TASK_STATUSES } from './task.js';

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
      COURT_TYPES,
      SESSION_TYPES,
      SESSION_OUTCOMES,
      SESSION_STATUSES,
      REMINDER_STATUSES,
      TASK_STATUSES,
      DOCUMENT_TYPES,
      DOCUMENT_STATUSES,
      OCR_STATUSES,
      DOCUMENT_LANGUAGES,
      FOLDER_SYSTEM_KEYS,
      SUBSCRIPTION_STATUSES,
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
