import { searchQuery } from './search-query';
import { Prisma } from '../../generated/prisma/client';

const ALL = Prisma.sql`true`;

const OFFICE = '01920000-0000-7000-8000-000000000001';

describe('searchQuery (D-165)', () => {
  it('should bind the office and the query, and add the trigram pass only where a name has one', () => {
    const files = searchQuery('files', OFFICE, "أحمد'; DROP", 20, ALL);
    expect(files.values).toEqual(expect.arrayContaining([OFFICE, "أحمد'; DROP", 20]));
    expect(files.sql).not.toContain('أحمد');
    expect(files.sql).toContain('"legal_files"');
    expect(files.sql).toContain('<%');
    const documents = searchQuery('documents', OFFICE, 'x', 5, ALL);
    expect(documents.sql).toContain('"document_texts"');
    expect(documents.sql).not.toContain('<%');
  });

  it('should refuse a limit that is not a whole number from 1 to 100', () => {
    expect(() => searchQuery('files', OFFICE, 'x', 101, ALL)).toThrow(RangeError);
  });
});
