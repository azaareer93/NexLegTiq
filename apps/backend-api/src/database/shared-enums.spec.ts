import {
  ACCOUNT_TYPES,
  BILLING_METHODS,
  CLIENT_TYPES,
  FILE_STATUSES,
  FILE_TEAM_ROLES,
  FILE_TYPES,
  JURISDICTIONS,
  OFFICE_LANGUAGES,
  PARTY_TYPES,
  PRIORITIES,
  ROLES,
  TASK_STATUSES,
} from '@nexlegtiq/shared-types';

import {
  AccountType,
  BillingMethod,
  ClientType,
  FileStatus,
  FileTeamRole,
  FileType,
  Jurisdiction,
  OfficeLanguage,
  PartyType,
  Priority,
  Role,
  TaskStatus,
} from '../generated/prisma/enums';

/** The enums in shared-types are hand-written copies of the Prisma enums used by the apps and contracts. */
describe('shared-types enums match the Prisma schema', () => {
  it.each([
    ['Jurisdiction', JURISDICTIONS, Jurisdiction],
    ['AccountType', ACCOUNT_TYPES, AccountType],
    ['OfficeLanguage', OFFICE_LANGUAGES, OfficeLanguage],
    ['Role', ROLES, Role],
    ['Priority', PRIORITIES, Priority],
    ['FileType', FILE_TYPES, FileType],
    ['FileStatus', FILE_STATUSES, FileStatus],
    ['ClientType', CLIENT_TYPES, ClientType],
    ['FileTeamRole', FILE_TEAM_ROLES, FileTeamRole],
    ['PartyType', PARTY_TYPES, PartyType],
    ['BillingMethod', BILLING_METHODS, BillingMethod],
    ['TaskStatus', TASK_STATUSES, TaskStatus],
  ] as const)('%s', (_name, shared, prisma) => {
    expect([...shared].sort()).toEqual(Object.values(prisma).sort());
  });
});
