import { searchQuery } from './search-query';

const OFFICE = '01920000-0000-7000-8000-000000000001';

describe('searchQuery (D-165)', () => {
  it('should bind the office and the query, and add the trigram pass only where a name has one', () => {
    const files = searchQuery('files', OFFICE, "أحمد'; DROP", 20);
    expect(files.values).toEqual(expect.arrayContaining([OFFICE, "أحمد'; DROP", 20]));
    expect(files.sql).not.toContain('أحمد');
    expect(files.sql).toContain('"legal_files"');
    expect(files.sql).toContain('<%');
    const documents = searchQuery('documents', OFFICE, 'x', 5);
    expect(documents.sql).toContain('"document_texts"');
    expect(documents.sql).not.toContain('<%');
  });
});
