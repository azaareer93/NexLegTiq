import { ACCOUNT_TYPES, JURISDICTIONS, OFFICE_LANGUAGES, ROLES } from '@nexlegtiq/shared-types';

import { AccountType, Jurisdiction, OfficeLanguage, Role } from '../generated/prisma/enums';

/** The enums in shared-types are hand-written copies of the Prisma enums used by the apps and contracts. */
describe('shared-types enums match the Prisma schema', () => {
  it.each([
    ['Jurisdiction', JURISDICTIONS, Jurisdiction],
    ['AccountType', ACCOUNT_TYPES, AccountType],
    ['OfficeLanguage', OFFICE_LANGUAGES, OfficeLanguage],
    ['Role', ROLES, Role],
  ] as const)('%s', (_name, shared, prisma) => {
    expect([...shared].sort()).toEqual(Object.values(prisma).sort());
  });
});
