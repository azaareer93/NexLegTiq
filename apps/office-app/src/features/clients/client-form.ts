import type { Client } from '@nexlegtiq/shared-contracts';

/** Form values of a client and the request bodies they turn into (D-121). */
export const TEXT_FIELDS = [
  'displayName',
  'nationalId',
  'taxId',
  'industry',
  'phone',
  'email',
  'address',
] as const;
export const FIELDS = ['clientType', ...TEXT_FIELDS, 'isActive'] as const;
export type Field = (typeof FIELDS)[number];
export type Values = Partial<Record<Field, string | boolean | null>>;

/** A person's fields differ from an organisation's (frontend.md#clients, D-121). */
export const isIndividual = (type: unknown) => type === 'INDIVIDUAL';
const ORGANISATION_ONLY: readonly Field[] = ['taxId', 'industry'];
const INDIVIDUAL_ONLY: readonly Field[] = ['nationalId'];
const hidden = (type: unknown): readonly Field[] =>
  isIndividual(type) ? ORGANISATION_ONLY : INDIVIDUAL_ONLY;

export function valuesOf(client: Client): Values {
  return {
    clientType: client.clientType,
    displayName: client.displayName,
    nationalId: client.nationalId ?? '',
    taxId: client.taxId ?? '',
    industry: client.industry ?? '',
    phone: client.phone ?? '',
    email: client.email ?? '',
    address: client.address ?? '',
    isActive: client.isActive,
  };
}

const trimmed = (value: Values[Field]) => (typeof value === 'string' ? value.trim() : value);

/** The name a person or an organisation is listed under is also its legal full / company name (D-121). */
function legalName(type: unknown, name: unknown): Record<string, unknown> {
  return isIndividual(type)
    ? { fullName: name, companyName: null }
    : { companyName: name, fullName: null };
}

/** The POST body: filled fields of the chosen type only. */
export function createBody(values: Values): Record<string, unknown> {
  const body: Record<string, unknown> = { clientType: values.clientType };
  for (const field of TEXT_FIELDS) {
    const value = trimmed(values[field]);
    if (
      value !== '' &&
      value !== undefined &&
      value !== null &&
      !hidden(values.clientType).includes(field)
    ) {
      body[field] = value;
    }
  }
  const { fullName, companyName } = legalName(values.clientType, body['displayName']);
  return { ...body, ...(isIndividual(values.clientType) ? { fullName } : { companyName }) };
}

/** The PATCH body: only what really changed; '' clears an optional field. */
export function changesOf(client: Client, values: Values): Record<string, unknown> {
  const before = valuesOf(client);
  const changes: Record<string, unknown> = {};
  for (const field of FIELDS) {
    const value = trimmed(values[field]);
    if (
      value !== undefined &&
      value !== before[field] &&
      !hidden(values.clientType).includes(field)
    ) {
      changes[field] = value === '' && field !== 'displayName' ? null : value;
    }
  }
  if ('displayName' in changes || 'clientType' in changes) {
    Object.assign(changes, legalName(values.clientType, trimmed(values.displayName)));
  }
  return changes;
}

export const newValues = (name = ''): Values => ({ clientType: 'INDIVIDUAL', displayName: name });
