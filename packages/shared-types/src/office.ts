/**
 * Office enums shared by the API and the apps. They mirror the Prisma enums of the same names (D-004, D-083); a backend
 * test keeps them in sync with the schema.
 */
export const JURISDICTIONS = [
  'PALESTINE',
  'JORDAN',
  'EGYPT',
  'SAUDI_ARABIA',
  'UAE',
  'KUWAIT',
  'QATAR',
  'OMAN',
  'BAHRAIN',
  'LEBANON',
  'IRAQ',
  'MOROCCO',
  'USA',
  'UK',
  'OTHER',
] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

export const ACCOUNT_TYPES = ['SOLO', 'FIRM', 'CORPORATE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const OFFICE_LANGUAGES = ['AR', 'EN', 'BILINGUAL'] as const;
export type OfficeLanguage = (typeof OFFICE_LANGUAGES)[number];
