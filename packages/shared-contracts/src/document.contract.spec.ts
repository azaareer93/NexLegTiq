import {
  OriginalFilenameSchema,
  UploadDocumentFieldsSchema,
  UploadVersionFieldsSchema,
} from './document.contract.js';

const FILE_ID = '01920000-0000-7000-8000-000000000001';

describe('document contracts (D-126)', () => {
  it('should default the type and read form booleans as words', () => {
    expect(UploadDocumentFieldsSchema.parse({ fileId: FILE_ID })).toEqual({
      fileId: FILE_ID,
      documentType: 'OTHER',
    });
    expect(
      UploadDocumentFieldsSchema.parse({ fileId: FILE_ID, isConfidential: 'false' }).isConfidential,
    ).toBe(false);
    expect(
      UploadDocumentFieldsSchema.safeParse({ fileId: FILE_ID, isConfidential: '1' }).success,
    ).toBe(false);
  });

  it('should keep Arabic names and refuse bidi tricks and empty names', () => {
    expect(OriginalFilenameSchema.parse(' عقد الإيجار.pdf ')).toBe('عقد الإيجار.pdf');
    expect(OriginalFilenameSchema.safeParse('gpj\u202Eexe.pdf').success).toBe(false);
    expect(OriginalFilenameSchema.safeParse('').success).toBe(false);
  });

  it('should take an optional change note up to 500 characters', () => {
    expect(UploadVersionFieldsSchema.parse({})).toEqual({});
    expect(UploadVersionFieldsSchema.safeParse({ changeNote: 'x'.repeat(501) }).success).toBe(
      false,
    );
  });
});
