import { RANKED_CANDIDATES, RECENT_WINDOW, searchQuery } from './search-query';
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

  it('should rank only the newest word matches (D-235)', () => {
    const { sql } = searchQuery('documents', OFFICE, 'عقد', 5, ALL);
    expect(sql).toMatch(new RegExp(`ORDER BY t\\."id" DESC\\s+LIMIT ${RANKED_CANDIDATES}\\b`));
  });

  it('should look in the newest rows first for documents only (D-240)', () => {
    const documents = searchQuery('documents', OFFICE, 'عقد', 5, ALL).sql;
    expect(documents).toMatch(new RegExp(`ORDER BY t\\."id" DESC LIMIT ${RECENT_WINDOW}\\)`));
    expect(documents).toContain('(SELECT count(*) FROM recent) <');
    expect(searchQuery('files', OFFICE, 'عقد', 5, ALL).sql).not.toContain('recent');
  });

  it('should refuse a limit that is not a whole number from 1 to 100', () => {
    expect(() => searchQuery('files', OFFICE, 'x', 101, ALL)).toThrow(RangeError);
  });
});
