import { Injectable } from '@nestjs/common';
import type { UserId } from '@nexlegtiq/shared-types';
import { ClsService } from 'nestjs-cls';

import type { RequestContext } from '../../common/context/request-context';
import {
  BusinessRuleException,
  ResourceNotFoundException,
} from '../../common/errors/app.exception';
import { assignedFilesWhere } from '../../common/rbac/case-scope';
import { PrismaService } from '../../database/prisma.service';
import type { Prisma } from '../../generated/prisma/client';
import { CaseAccessService } from '../legal-files/case-access.service';

export interface AccessibleDocument {
  readonly id: string;
  readonly fileId: string;
  readonly uploadedById: string;
}

/**
 * Who may reach a document (D-126). It follows its file (`CaseAccessService`: scope, confidential files, 404 otherwise);
 * a **confidential document** is seen only by the office manager, its uploader and the people assigned to the file —
 * like a confidential file (D-096), also hidden from senior lawyers and admins who see every file. Adding to a document
 * (`contribute`) needs a file that is not archived (BIZ-007). Deleted documents are 404.
 */
@Injectable()
export class DocumentAccessService {
  constructor(
    private readonly cls: ClsService<RequestContext>,
    private readonly prisma: PrismaService,
    private readonly files: CaseAccessService,
  ) {}

  /** Live documents the caller may see; lists of the documents story use it too. */
  visibleWhere(): Prisma.DocumentWhereInput {
    const userId = this.cls.get('userId');
    const role = this.cls.get('role');
    if (!userId || !role) throw new Error('No office caller in the request context');
    const fileVisible = { deletedAt: null, file: this.files.visibleWhere() };
    if (role === 'OFFICE_MANAGER') return fileVisible;
    return {
      ...fileVisible,
      OR: [
        { isConfidential: false },
        { uploadedById: userId },
        { file: assignedFilesWhere(userId as UserId) },
      ],
    };
  }

  async assertDocumentAccess(id: string, mode: 'read' | 'contribute'): Promise<AccessibleDocument> {
    const document = await this.prisma.db.document.findFirst({
      where: { AND: [{ id }, this.visibleWhere()] },
      select: { id: true, fileId: true, uploadedById: true, file: { select: { status: true } } },
    });
    if (!document) throw new ResourceNotFoundException();
    if (mode === 'contribute' && document.file.status === 'ARCHIVED') {
      throw new BusinessRuleException('BIZ-007', 'The file is archived and read-only');
    }
    return { id: document.id, fileId: document.fileId, uploadedById: document.uploadedById };
  }

  /**
   * Replacing a document's content (a new version) is for its uploader or someone who may edit the file (`edit:any|
   * assigned:case`, 403/404 otherwise): adding documents (`upload:document`) alone does not let a trainee or an outside
   * collaborator overwrite a colleague's.
   */
  async assertMayReplace(document: AccessibleDocument): Promise<void> {
    if (document.uploadedById === this.cls.get('userId')) return;
    await this.files.assertFileAccess(document.fileId, 'write');
  }
}
