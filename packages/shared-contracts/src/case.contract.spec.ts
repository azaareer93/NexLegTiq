import { CaseQuerySchema, CreateCaseSchema, UpdateCaseSchema } from './case.contract.js';

const CLIENT = '01920000-0000-7000-8000-0000000000c1';
const LAWYER = '01920000-0000-7000-8000-000000000002';
const base = {
  title: '  Land dispute  ',
  fileType: 'LITIGATION',
  clientIds: [CLIENT],
  primaryClientId: CLIENT,
  responsibleLawyerId: LAWYER,
};

const issues = (result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) => (result.error?.issues ?? []).map((issue) => `${issue.path.join('.')}: ${issue.message}`);

describe('CreateCaseSchema', () => {
  it('should trim text and apply the defaults', () => {
    expect(CreateCaseSchema.parse(base)).toEqual({
      ...base,
      title: 'Land dispute',
      priority: 'MEDIUM',
      isConfidential: false,
    });
  });

  it('should keep line breaks in a description', () => {
    expect(
      CreateCaseSchema.parse({ ...base, description: 'Line 1\nLine 2\tend' }).description,
    ).toBe('Line 1\nLine 2\tend');
  });

  it.each([
    [{ title: '   ' }, 'title: validation.required'],
    [{ title: 'a‮b' }, 'title: validation.invalidCharacters'],
    [{ description: 'a\u0007b' }, 'description: validation.invalidCharacters'],
    [{ clientIds: [] }, 'clientIds: validation.required'],
    [{ clientIds: [CLIENT, CLIENT] }, 'clientIds: validation.duplicate'],
    [{ primaryClientId: LAWYER }, 'primaryClientId: validation.primaryClient'],
    [{ hourlyRate: '-1' }, 'hourlyRate: validation.amount'],
    [{ fixedFee: '1.234' }, 'fixedFee: validation.amount'],
    [{ fixedFee: '1e5' }, 'fixedFee: validation.amount'],
  ])('should refuse %j', (overrides, issue) => {
    expect(issues(CreateCaseSchema.safeParse({ ...base, ...overrides }))).toContain(issue);
  });
});

describe('UpdateCaseSchema', () => {
  it('should accept a partial change and null for clearable fields', () => {
    expect(UpdateCaseSchema.parse({ courtCaseNumber: null, priority: 'HIGH' })).toEqual({
      courtCaseNumber: null,
      priority: 'HIGH',
    });
  });

  it('should refuse an empty change, and drop fields that are not editable here', () => {
    expect(issues(UpdateCaseSchema.safeParse({}))).toEqual([': validation.required']);
    expect(issues(UpdateCaseSchema.safeParse({ fileNumber: 'X-1' }))).toEqual([
      ': validation.required',
    ]);
  });
});

describe('CaseQuerySchema', () => {
  it('should default scope, sort and paging, and coerce numbers', () => {
    expect(CaseQuerySchema.parse({ page: '2' })).toEqual({
      scope: 'all',
      sort: [{ field: 'updatedAt', direction: 'desc' }],
      page: 2,
      limit: 20,
    });
  });

  it('should parse several sort keys with an optional direction', () => {
    expect(CaseQuerySchema.parse({ sort: 'priority:desc, title' }).sort).toEqual([
      { field: 'priority', direction: 'desc' },
      { field: 'title', direction: 'asc' },
    ]);
  });

  it.each(['passwordHash', 'title:up', 'title:asc:x', '', 'title:asc,title:desc'])(
    'should refuse the sort %j',
    (sort) => {
      expect(issues(CaseQuerySchema.safeParse({ sort }))).toEqual(['sort: validation.sort']);
    },
  );

  it.each([
    { limit: '101' },
    { page: '0' },
    { scope: 'everyone' },
    { clientId: 'x' },
    { search: 'a\u202Eb' },
  ])('should refuse %j', (query) => {
    expect(CaseQuerySchema.safeParse(query).success).toBe(false);
  });
});
