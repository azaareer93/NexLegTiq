import type { Role } from '@nexlegtiq/shared-types';
import type { ClsService } from 'nestjs-cls';

import { DocumentAccessService } from './document-access.service';
import type { RequestContext } from '../../common/context/request-context';
import type { PrismaService } from '../../database/prisma.service';
import type { CaseAccessService } from '../legal-files/case-access.service';

const FILE_VISIBLE = { deletedAt: null, visible: true };

function setup(role: Role | undefined, found: { status: string } | null = { status: 'OPEN' }) {
  const context: Partial<RequestContext> = { userId: 'u1' as never, role };
  const findFirst = jest
    .fn()
    .mockResolvedValue(found && { id: 'd1', fileId: 'f1', file: { status: found.status } });
  const service = new DocumentAccessService(
    { get: (key: keyof RequestContext) => context[key] } as unknown as ClsService<RequestContext>,
    { db: { document: { findFirst } } } as unknown as PrismaService,
    { visibleWhere: () => FILE_VISIBLE } as unknown as CaseAccessService,
  );
  return { service, findFirst };
}

describe('DocumentAccessService', () => {
  it('should let the office manager see every document of a visible file', () => {
    expect(setup('OFFICE_MANAGER').service.visibleWhere()).toEqual({
      deletedAt: null,
      file: FILE_VISIBLE,
    });
  });

  it('should limit confidential documents to their uploader and the file team for others', () => {
    const where = setup('SENIOR_LAWYER').service.visibleWhere();
    expect(where.OR).toEqual([
      { isConfidential: false },
      { uploadedById: 'u1' },
      { file: expect.objectContaining({ OR: expect.any(Array) }) as unknown },
    ]);
    expect(() => setup(undefined).service.visibleWhere()).toThrow('No office caller');
  });

  it('should answer 404 for an unreachable document and BIZ-007 for adding to an archived file', async () => {
    await expect(setup('LAWYER').service.assertDocumentAccess('d1', 'read')).resolves.toEqual({
      id: 'd1',
      fileId: 'f1',
    });
    await expect(
      setup('LAWYER', null).service.assertDocumentAccess('d1', 'read'),
    ).rejects.toMatchObject({ code: 'RES-001' });
    const archived = setup('LAWYER', { status: 'ARCHIVED' });
    await expect(archived.service.assertDocumentAccess('d1', 'read')).resolves.toBeTruthy();
    await expect(archived.service.assertDocumentAccess('d1', 'contribute')).rejects.toMatchObject({
      code: 'BIZ-007',
    });
  });
});
