/**
 * Legal-file enums shared by the API and the apps (domain-model.md, D-033, D-034). They mirror the Prisma enums of the
 * same names; a backend test keeps them in sync with the schema. Labels: `enums.<name>.<VALUE>`.
 */
export const FILE_TYPES = [
  'LITIGATION',
  'CRIMINAL',
  'CONTRACT_DRAFTING',
  'LEGAL_ADVISORY',
  'COMPLIANCE',
  'CONFLICT_RESOLUTION',
  'BUSINESS_SUPPORT',
  'NDA_REVIEW',
  'WILL_TRUST',
  'COMPANY_FORMATION',
  'RENTAL_AGREEMENT',
  'EMPLOYMENT_CONTRACT',
] as const;
export type FileType = (typeof FILE_TYPES)[number];

export const FILE_STATUSES = ['OPEN', 'SUSPENDED', 'CLOSED', 'ARCHIVED'] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

export const CLIENT_TYPES = [
  'INDIVIDUAL',
  'CORPORATION',
  'GOVERNMENT',
  'NGO',
  'PARTNERSHIP',
] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export const FILE_TEAM_ROLES = ['RESPONSIBLE_LAWYER', 'PARALEGAL', 'MEMBER'] as const;
export type FileTeamRole = (typeof FILE_TEAM_ROLES)[number];

export const PARTY_TYPES = [
  'PLAINTIFF',
  'DEFENDANT',
  'APPELLANT',
  'RESPONDENT',
  'THIRD_PARTY',
  'GUARANTOR',
  'SIGNATORY',
  'INTERESTED_PARTY',
  'PROSECUTION',
] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

export const BILLING_METHODS = ['HOURLY', 'FIXED_FEE', 'RETAINER', 'CONTINGENCY'] as const;
export type BillingMethod = (typeof BILLING_METHODS)[number];
