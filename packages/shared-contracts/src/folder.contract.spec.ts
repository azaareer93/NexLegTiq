import { CreateFolderSchema, UpdateFolderSchema } from './folder.contract.js';

const FOLDER = '01920000-0000-7000-8000-0000000000f1';

const messages = (result: { error?: { issues: { message: string }[] } }) =>
  (result.error?.issues ?? []).map((issue) => issue.message);

describe('CreateFolderSchema', () => {
  it('should trim the name and accept an optional parent', () => {
    expect(CreateFolderSchema.parse({ name: '  مذكرات  ', parentId: FOLDER })).toEqual({
      name: 'مذكرات',
      parentId: FOLDER,
    });
    expect(CreateFolderSchema.parse({ name: 'Drafts' })).toEqual({ name: 'Drafts' });
  });

  it('should refuse a blank, too long or bidi-spoofed name and a malformed parent', () => {
    expect(messages(CreateFolderSchema.safeParse({ name: '   ' }))).toEqual([
      'validation.required',
    ]);
    expect(messages(CreateFolderSchema.safeParse({ name: 'x'.repeat(101) }))).toEqual([
      'validation.tooLong',
    ]);
    expect(
      messages(CreateFolderSchema.safeParse({ name: `a${String.fromCharCode(0x202e)}b` })),
    ).toEqual(['validation.invalidCharacters']);
    expect(CreateFolderSchema.safeParse({ name: 'x', parentId: 'nope' }).success).toBe(false);
  });
});

describe('UpdateFolderSchema', () => {
  it('should accept a rename, a move to the root or both', () => {
    expect(UpdateFolderSchema.parse({ name: 'New' })).toEqual({ name: 'New' });
    expect(UpdateFolderSchema.parse({ parentId: null })).toEqual({ parentId: null });
  });

  it('should refuse an empty change', () => {
    expect(messages(UpdateFolderSchema.safeParse({}))).toEqual(['validation.required']);
  });
});
