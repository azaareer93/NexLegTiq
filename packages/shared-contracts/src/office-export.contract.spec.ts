import {
  OfficeExportDownloadSchema,
  OfficeExportSchema,
  UserExportSchema,
} from './office-export.contract.js';

const ID = '01920000-0000-7000-8000-0000000000e1';

describe('office export contracts (D-184)', () => {
  it('should read an export with its size as text, and a short download link', () => {
    const row = {
      id: ID,
      status: 'READY',
      requestedBy: { id: ID, fullName: 'Layla' },
      sizeBytes: '1024',
      checksum: 'a'.repeat(64),
      errorCode: null,
      expiresAt: '2026-11-22T10:00:00.000Z',
      createdAt: '2026-11-15T10:00:00.000Z',
      completedAt: '2026-11-15T10:05:00.000Z',
    };
    expect(OfficeExportSchema.parse(row)).toEqual(row);
    expect(OfficeExportSchema.safeParse({ ...row, sizeBytes: '1.5' }).success).toBe(false);
    expect(OfficeExportSchema.safeParse({ ...row, status: 'DONE' }).success).toBe(false);
    expect(
      OfficeExportDownloadSchema.safeParse({ downloadUrl: 'https://s3.test/x.zip', expiresIn: 900 })
        .success,
    ).toBe(true);
    expect(
      OfficeExportDownloadSchema.safeParse({ downloadUrl: 'nope', expiresIn: 0 }).success,
    ).toBe(false);
  });

  it('should take a user export of its own format and keep extra keys', () => {
    const data = {
      format: 'nexlegtiq-user-export/1',
      createdAt: '2026-11-15T10:00:00.000Z',
      profile: { fullName: 'Omar' },
      tasks: [],
      timeEntries: [],
      notes: [],
      audit: [],
      extra: true,
    };
    expect(UserExportSchema.parse(data)).toMatchObject({ extra: true });
    expect(UserExportSchema.safeParse({ ...data, format: 'other' }).success).toBe(false);
  });
});
