import { TenantViolationError } from './tenant.errors';

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** `where.<field> = value`; a caller-supplied different value (or filter object) is a violation, never overridden. */
export function withField(where: unknown, field: string, value: string, target: string): Json {
  const scoped: Json = isObject(where) ? { ...where } : {};
  if (field in scoped && scoped[field] !== value) {
    throw new TenantViolationError(`${target}: where.${field} does not match the current office`);
  }
  scoped[field] = value;
  return scoped;
}

/**
 * `where` of a reference model (D-037, D-115) limited to platform rows (`officeId` null) and the office's own. The
 * condition is ANDed, so nothing the caller wrote (OR, NOT…) can widen it; a caller's `officeId` must be null or the
 * current office.
 */
export function visibleWhere(where: unknown, officeId: string, target: string): Json {
  const scoped: Json = isObject(where) ? { ...where } : {};
  if ('officeId' in scoped && scoped['officeId'] !== null && scoped['officeId'] !== officeId) {
    throw new TenantViolationError(`${target}: where.officeId names another office`);
  }
  const and: unknown = scoped['AND'];
  const callerAnd: unknown[] = and === undefined ? [] : Array.isArray(and) ? and : [and];
  scoped['AND'] = [...callerAnd, { OR: [{ officeId: null }, { officeId }] }];
  return scoped;
}
