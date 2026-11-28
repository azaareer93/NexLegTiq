import { assertNewFileType, assertOfficeFileType, nextSubType } from './file-type-refs';
import { ValidationException } from '../../common/errors/app.exception';
import type { ScopedTransaction } from '../../database/unit-of-work';

const SUB = '01920000-0000-7000-8000-0000000000d1';
const OTHER = '01920000-0000-7000-8000-0000000000d2';

function tx(type: { numberCode: string } | null = { numberCode: 'LIT' }, subTypes = 1, types = 1) {
  const mock = {
    legalFileType: {
      findFirst: jest.fn().mockResolvedValue(type),
      count: jest.fn().mockResolvedValue(types),
    },
    legalFileSubType: { count: jest.fn().mockResolvedValue(subTypes) },
    office: { findFirstOrThrow: jest.fn().mockResolvedValue({ jurisdiction: 'JORDAN' }) },
  };
  return { mock, tx: mock as unknown as ScopedTransaction };
}

const detail = (error: unknown) => (error as ValidationException).details;

describe('assertNewFileType (D-261)', () => {
  it("should return the type's number code and check the sub-type against the type", async () => {
    const { mock, tx: t } = tx();
    await expect(assertNewFileType(t, 'PALESTINE', 'LITIGATION', SUB)).resolves.toBe('LIT');
    expect(mock.legalFileSubType.count).toHaveBeenCalledWith({
      where: { id: SUB, jurisdiction: 'PALESTINE', typeCode: 'LITIGATION', isActive: true },
    });
    await expect(assertNewFileType(t, 'PALESTINE', 'LITIGATION', undefined)).resolves.toBe('LIT');
    expect(mock.legalFileSubType.count).toHaveBeenCalledTimes(1);
  });

  it('should refuse an unknown or inactive type, then a sub-type of another type', async () => {
    const noType = await assertNewFileType(tx(null).tx, 'PALESTINE', 'X_Y', undefined).catch(
      (error: unknown) => error,
    );
    expect(noType).toBeInstanceOf(ValidationException);
    expect(JSON.stringify(detail(noType))).toContain('validation.unknownFileType');
    const noSub = await assertNewFileType(
      tx({ numberCode: 'LIT' }, 0).tx,
      'PALESTINE',
      'L',
      SUB,
    ).catch((error: unknown) => error);
    expect(JSON.stringify(detail(noSub))).toContain('validation.unknownSubType');
  });
});

describe('nextSubType (D-261)', () => {
  const file = { jurisdiction: 'PALESTINE' as const, fileType: 'LITIGATION', subTypeId: SUB };

  it('should leave the file alone when the PATCH does not touch the sub-type', async () => {
    await expect(nextSubType(tx().tx, file, undefined)).resolves.toEqual({});
  });

  it('should clear the legacy text when a sub-type is cleared, kept or newly picked', async () => {
    const { mock, tx: t } = tx();
    await expect(nextSubType(t, file, null)).resolves.toEqual({
      subTypeId: null,
      legacySubType: null,
    });
    // Keeping the current one (even deactivated since) needs no check.
    await expect(nextSubType(t, file, SUB)).resolves.toEqual({
      subTypeId: SUB,
      legacySubType: null,
    });
    expect(mock.legalFileSubType.count).not.toHaveBeenCalled();
    await expect(nextSubType(t, file, OTHER)).resolves.toEqual({
      subTypeId: OTHER,
      legacySubType: null,
    });
    expect(mock.legalFileSubType.count).toHaveBeenCalledWith({
      where: { id: OTHER, jurisdiction: 'PALESTINE', typeCode: 'LITIGATION', isActive: true },
    });
  });

  it('should refuse a new sub-type that is inactive or of another type', async () => {
    await expect(nextSubType(tx(undefined, 0).tx, file, OTHER)).rejects.toBeInstanceOf(
      ValidationException,
    );
  });
});

describe('assertOfficeFileType (D-261)', () => {
  it('should accept every type (null) without a query', async () => {
    const { mock, tx: t } = tx();
    await assertOfficeFileType(t, null);
    await assertOfficeFileType(t, undefined);
    expect(mock.office.findFirstOrThrow).not.toHaveBeenCalled();
  });

  it("should check the code against the office's country", async () => {
    const { mock, tx: t } = tx();
    await assertOfficeFileType(t, 'LITIGATION');
    expect(mock.legalFileType.count).toHaveBeenCalledWith({
      where: { jurisdiction: 'JORDAN', code: 'LITIGATION', isActive: true },
    });
    await expect(assertOfficeFileType(tx(undefined, 1, 0).tx, 'GONE')).rejects.toBeInstanceOf(
      ValidationException,
    );
  });
});
