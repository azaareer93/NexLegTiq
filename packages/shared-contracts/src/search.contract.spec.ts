import { SearchQuerySchema } from './search.contract.js';

describe('SearchQuerySchema', () => {
  it('should take the names step and default to all (D-240)', () => {
    expect(SearchQuerySchema.parse({ q: 'عقد', type: 'names' })).toEqual({
      q: 'عقد',
      type: 'names',
      limit: 5,
    });
    expect(SearchQuerySchema.parse({ q: 'عقد' }).type).toBe('all');
  });

  it('should refuse an unknown type and a one-character query', () => {
    expect(SearchQuerySchema.safeParse({ q: 'عقد', type: 'titles' }).success).toBe(false);
    const short = SearchQuerySchema.safeParse({ q: 'ع' });
    expect(short.error?.issues[0]?.message).toBe('validation.tooShort');
  });
});
