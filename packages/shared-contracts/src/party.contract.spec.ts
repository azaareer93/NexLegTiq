import {
  AddFilePartySchema,
  ConflictQuerySchema,
  NewPartySchema,
  PartyQuerySchema,
  ResolveConflictSchema,
  UpdateFilePartySchema,
} from './party.contract.js';

const PARTY = '01920000-0000-7000-8000-0000000000a1';

const messages = (result: { error?: { issues: { message: string }[] } }) =>
  (result.error?.issues ?? []).map((issue) => issue.message);

describe('NewPartySchema', () => {
  it('should need a full name for a person and a company name for an organisation', () => {
    expect(NewPartySchema.safeParse({ isIndividual: true, fullName: ' أحمد ' }).data).toEqual({
      isIndividual: true,
      fullName: 'أحمد',
    });
    expect(messages(NewPartySchema.safeParse({ isIndividual: true, companyName: 'X' }))).toEqual([
      'validation.required',
    ]);
    expect(NewPartySchema.safeParse({ isIndividual: false, companyName: 'Org' }).success).toBe(
      true,
    );
  });
});

describe('AddFilePartySchema', () => {
  it('should take exactly one of an existing party or a new one', () => {
    expect(AddFilePartySchema.safeParse({ partyId: PARTY, partyType: 'DEFENDANT' }).success).toBe(
      true,
    );
    expect(
      AddFilePartySchema.safeParse({
        party: { isIndividual: true, fullName: 'A' },
        partyType: 'PLAINTIFF',
      }).success,
    ).toBe(true);
    for (const body of [
      { partyType: 'PLAINTIFF' },
      { partyId: PARTY, party: { isIndividual: true, fullName: 'A' }, partyType: 'PLAINTIFF' },
    ]) {
      expect(messages(AddFilePartySchema.safeParse(body))).toEqual(['validation.partyChoice']);
    }
    expect(AddFilePartySchema.safeParse({ partyId: PARTY, partyType: 'JUDGE' }).success).toBe(
      false,
    );
  });
});

describe('party and conflict queries', () => {
  it('should default and bound the queries, and let a role label be cleared', () => {
    expect(PartyQuerySchema.parse({})).toEqual({ search: '', limit: 20 });
    expect(PartyQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(ConflictQuerySchema.parse({ resolved: 'false' })).toEqual({
      resolved: 'false',
      page: 1,
      limit: 20,
    });
    expect(UpdateFilePartySchema.parse({ roleLabel: null })).toEqual({ roleLabel: null });
    expect(messages(ResolveConflictSchema.safeParse({ notes: '   ' }))).toEqual([
      'validation.required',
    ]);
  });
});
