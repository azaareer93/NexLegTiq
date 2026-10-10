import {
  ClientQuerySchema,
  CreateClientSchema,
  CreateContactPersonSchema,
  UpdateClientSchema,
  UpdateContactPersonSchema,
} from './client.contract.js';

const messages = (result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  (result.error?.issues ?? []).map((issue) => `${issue.path.join('.')}: ${issue.message}`);

describe('CreateClientSchema', () => {
  it('should trim names, lower-case the email and keep Arabic text', () => {
    expect(
      CreateClientSchema.parse({
        clientType: 'INDIVIDUAL',
        displayName: '  أحمد حداد ',
        nationalId: ' 401234567 ',
        email: ' Ahmad@Example.TEST ',
        phone: '+970 59 123 4567',
      }),
    ).toEqual({
      clientType: 'INDIVIDUAL',
      displayName: 'أحمد حداد',
      nationalId: '401234567',
      email: 'ahmad@example.test',
      phone: '+970 59 123 4567',
    });
  });

  it.each([
    [{ clientType: 'PERSON', displayName: 'A' }, 'clientType: Invalid option'],
    [{ clientType: 'NGO', displayName: ' ' }, 'displayName: validation.required'],
    [{ clientType: 'NGO', displayName: 'A‮b' }, 'displayName: validation.invalidCharacters'],
    [{ clientType: 'NGO', displayName: 'A', email: 'x' }, 'email: validation.email'],
    [{ clientType: 'NGO', displayName: 'A', phone: 'call me' }, 'phone: validation.phone'],
    [
      { clientType: 'NGO', displayName: 'A', primaryLawyerId: 'x' },
      'primaryLawyerId: Invalid UUID',
    ],
  ])('should reject %j', (body, message) => {
    expect(messages(CreateClientSchema.safeParse(body)).join('|')).toContain(message);
  });
});

describe('UpdateClientSchema', () => {
  it('should accept null to clear an optional field and refuse an empty change', () => {
    expect(UpdateClientSchema.parse({ nationalId: null, isActive: false })).toEqual({
      nationalId: null,
      isActive: false,
    });
    expect(messages(UpdateClientSchema.safeParse({}))).toEqual([': validation.required']);
    expect(UpdateClientSchema.safeParse({ displayName: null }).success).toBe(false);
  });
});

describe('ClientQuerySchema', () => {
  it('should default to name order and parse filters', () => {
    expect(ClientQuerySchema.parse({})).toEqual({
      sort: [{ field: 'name', direction: 'asc' }],
      page: 1,
      limit: 20,
    });
    expect(
      ClientQuerySchema.parse({
        isActive: 'false',
        clientType: 'NGO',
        sort: 'openFiles:desc,name',
      }),
    ).toMatchObject({
      isActive: false,
      clientType: 'NGO',
      sort: [
        { field: 'openFiles', direction: 'desc' },
        { field: 'name', direction: 'asc' },
      ],
    });
  });

  it('should refuse unknown sort fields and over-long pages', () => {
    expect(messages(ClientQuerySchema.safeParse({ sort: 'nationalId' }))).toEqual([
      'sort: validation.sort',
    ]);
    expect(ClientQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});

describe('contact person schemas', () => {
  it('should default isPrimary to false on create', () => {
    expect(CreateContactPersonSchema.parse({ fullName: 'Sara' })).toEqual({
      fullName: 'Sara',
      isPrimary: false,
    });
  });

  it('should only accept promoting a contact, never demoting it', () => {
    expect(UpdateContactPersonSchema.parse({ isPrimary: true })).toEqual({ isPrimary: true });
    expect(messages(UpdateContactPersonSchema.safeParse({ isPrimary: false }))).toEqual([
      'isPrimary: validation.primaryContact',
    ]);
  });
});
