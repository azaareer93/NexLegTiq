import type { DirectoryUser } from '@nexlegtiq/shared-contracts';
import type { Role } from '@nexlegtiq/shared-types';

/** Fields of the quick-create form; `clientId` becomes `clientIds` + `primaryClientId` (one client at creation). */
export const CREATE_FIELDS = [
  'title',
  'clientId',
  'fileType',
  'subType',
  'priority',
  'responsibleLawyerId',
  'responsibleParalegalId',
  'billingMethod',
  'hourlyRate',
  'fixedFee',
  'courtId',
  'judgeId',
  'description',
] as const;
export type CreateField = (typeof CREATE_FIELDS)[number];
export type CreateValues = Partial<Record<CreateField, string | null>>;

/** Who may be a file's responsible lawyer (the API's rule, D-096). */
const LAWYER_ROLES: ReadonlySet<Role> = new Set(['OFFICE_MANAGER', 'SENIOR_LAWYER', 'LAWYER']);

export const lawyersOf = (people: readonly DirectoryUser[]) =>
  people.filter((person) => LAWYER_ROLES.has(person.role));
export const paralegalsOf = (people: readonly DirectoryUser[]) =>
  people.filter((person) => person.role === 'PARALEGAL');

/** The caller is the default responsible lawyer when the API would accept them. */
export const defaultLawyer = (user: { id: string; role: Role } | null): string | undefined =>
  user && LAWYER_ROLES.has(user.role) ? user.id : undefined;

/** The POST body: trimmed, empty fields left out (the office supplies billing defaults, D-096). */
export function createBody(values: CreateValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of CREATE_FIELDS) {
    const value = values[field]?.trim();
    if (value) body[field] = value;
  }
  // The form keeps a hidden field's value: a rate typed before switching to a fixed fee must not be sent.
  if (body['billingMethod'] !== 'HOURLY') delete body['hourlyRate'];
  if (body['billingMethod'] !== 'FIXED_FEE') delete body['fixedFee'];
  const { clientId, ...rest } = body;
  return clientId === undefined
    ? rest
    : { ...rest, clientIds: [clientId], primaryClientId: clientId };
}
